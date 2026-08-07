import type * as THREE from 'three';
import type { World } from '../core/types';
import { BUILDING_TYPES } from '../data/buildings';
import {
  cmdAddChainStep, cmdAssignBuilders, cmdAttackMove, cmdGather, cmdMove, cmdPatrol, cmdPlaceBuilding,
  cmdSetRally, cmdSetSelection,
} from '../sim/commands';
import type { RtsCamera } from '../render/camera';
import type { PlacementGhost } from '../render/placementGhost';
import type { CommandFeedbackKind } from '../render/commandFeedback';
import type { UiState } from './selection';
import { ownerIdOf, screenPosOf, selectedIds } from './selection';
import { normalizedScreenRect, screenPointInRect } from './selectionMath';
import { resolvePick } from './pickPriority';
import { issueCommand } from '../replay/live';

type Picker = ReturnType<typeof import('./selection').createPicker>;

export interface MouseDeps {
  world: World;
  domElement: HTMLCanvasElement;
  cam: RtsCamera;
  picker: Picker;
  ghost: PlacementGhost;
  ui: UiState;
  flash: (msg: string) => void;
  commandFeedback: (x: number, y: number, z: number, kind: CommandFeedbackKind) => void;
}

export function createMouse(deps: MouseDeps): void {
  const { world, domElement, cam, picker, ghost, ui, flash, commandFeedback } = deps;
  const selboxEl = document.getElementById('selbox');
  let dragStart: { x: number; y: number } | null = null;
  let orbitLast: { x: number; y: number } | null = null;
  let dragging = false;

  /** Keep the chain editor pointed at whatever the player is looking at: if
   *  the whole selection belongs to one squad, show that squad's chain. */
  function followSelection(): void {
    const sel = world.units.filter(u => u.selected);
    const owner = sel.length
      ? world.squads.find(s => sel.every(u => s.memberIds.includes(u.id)))
      : undefined;
    ui.selectedSquadId = owner?.id ?? null;
    ui.armedBehaviour = null;
  }

  domElement.addEventListener('wheel', e => {
    e.preventDefault();
    cam.zoom(e.deltaY, e.clientX, e.clientY);
  }, { passive: false });
  domElement.addEventListener('contextmenu', e => e.preventDefault());

  domElement.addEventListener('mousedown', e => {
    if (e.button === 1) {
      orbitLast = { x: e.clientX, y: e.clientY };
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    dragStart = { x: e.clientX, y: e.clientY };
    dragging = false;
  });

  domElement.addEventListener('mousemove', e => {
    if (orbitLast) {
      cam.orbit(e.clientX - orbitLast.x, e.clientY - orbitLast.y);
      orbitLast = { x: e.clientX, y: e.clientY };
      return;
    }
    if (ui.placingType) {
      picker.setFromEvent(e);
      ghost.update(world, ui.placingType, picker.ground());
    }
    if (!dragStart || !selboxEl) return;
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    if (Math.hypot(dx, dy) > 4) {
      dragging = true;
      selboxEl.style.display = 'block';
      selboxEl.style.left = `${Math.min(dragStart.x, e.clientX)}px`;
      selboxEl.style.top = `${Math.min(dragStart.y, e.clientY)}px`;
      selboxEl.style.width = `${Math.abs(dx)}px`;
      selboxEl.style.height = `${Math.abs(dy)}px`;
    }
  });

  // One consolidated mouseup. Phase 0 had two competing listeners here (06 §6).
  domElement.addEventListener('mouseup', e => {
    if (e.button === 1) { orbitLast = null; return; }

    // ---- left while placing: commit the building ----
    if (e.button === 0 && ui.placingType) {
      picker.setFromEvent(e);
      const hit = picker.ground();
      if (hit) {
        const type = ui.placingType;
        const builders = world.units.filter(u => u.selected && u.build).map(u => u.id);
        const res = issueCommand(
          { t: 'place', team: 'player', type, x: hit.point.x, z: hit.point.z, builders },
          () => cmdPlaceBuilding(world, 'player', type, hit.point.x, hit.point.z, builders),
        );
        flash(res.ok
          ? (builders.length
            ? `${BUILDING_TYPES[type].label} sited — worker heading over`
            : 'sited, but no worker assigned')
          : res.reason ?? 'cannot place there');
        if (res.ok && !e.shiftKey) { ui.placingType = null; ghost.hide(); }
      }
      dragStart = null;
      dragging = false;
      return;
    }

    // ---- left while a direct order is armed: choose its destination ----
    if (e.button === 0 && ui.armedOrder && !dragging) {
      picker.setFromEvent(e);
      const hit = picker.ground();
      const units = selectedIds(world);
      if (hit && units.length) {
        const order = ui.armedOrder;
        if (order === 'attackMove') {
          issueCommand(
            { t: 'attackMove', units, x: hit.point.x, z: hit.point.z },
            () => cmdAttackMove(world, units, hit.point.x, hit.point.z),
          );
          commandFeedback(hit.point.x, hit.point.y, hit.point.z, 'attack');
          flash('attack-move order');
        } else {
          issueCommand(
            { t: 'patrol', units, x: hit.point.x, z: hit.point.z },
            () => cmdPatrol(world, units, hit.point.x, hit.point.z),
          );
          commandFeedback(hit.point.x, hit.point.y, hit.point.z, 'move');
          flash('patrol route set');
        }
      } else if (!units.length) {
        flash('select units first');
      }
      ui.armedOrder = null;
      if (selboxEl) selboxEl.style.display = 'none';
      dragStart = null;
      dragging = false;
      return;
    }

    // ---- left while a behaviour is armed: site that chain step ----
    if (e.button === 0 && ui.armedBehaviour && ui.selectedSquadId !== null && !dragging) {
      picker.setFromEvent(e);
      const hit = picker.ground();
      if (hit) {
        const kind = ui.armedBehaviour;
        const squad = ui.selectedSquadId;
        const res = issueCommand(
          { t: 'addChainStep', squad, kind, x: hit.point.x, z: hit.point.z },
          () => cmdAddChainStep(world, squad, kind, hit.point.x, hit.point.z),
        );
        flash(res.ok ? `${kind} step added` : res.reason ?? 'cannot add that step');
        ui.armedBehaviour = null;
      }
      if (selboxEl) selboxEl.style.display = 'none';
      dragStart = null;
      dragging = false;
      return;
    }

    // ---- left: selection ----
    if (e.button === 0 && dragStart) {
      if (dragging) {
        const rect = normalizedScreenRect(dragStart.x, dragStart.y, e.clientX, e.clientY);
        ui.selectedBuildingId = null;
        ui.selectedSiteId = null;
        const units = world.units.filter(u => {
          // Rival units are not selectable or commandable (06 §6).
          if (u.team !== 'player') return false;
          const p = screenPosOf(cam.camera, u.x, u.z);
          return screenPointInRect(p, rect);
        }).map(u => u.id);
        issueCommand({ t: 'select', units }, () => cmdSetSelection(world, units));
        followSelection();
      } else {
        picker.setFromEvent(e);
        const unitHit = picker.unit();
        const bldHit = picker.building();
        const siteHit = picker.site();
        const near = resolvePick([
          ...(unitHit ? [{ kind: 'unit' as const, distance: unitHit.distance, value: unitHit }] : []),
          ...(siteHit ? [{ kind: 'site' as const, distance: siteHit.distance, value: siteHit }] : []),
          ...(bldHit ? [{ kind: 'building' as const, distance: bldHit.distance, value: bldHit }] : []),
        ])?.value;

        if (siteHit && near === siteHit) {
          ui.selectedBuildingId = null;
          issueCommand({ t: 'select', units: [] }, () => cmdSetSelection(world, []));
          ui.selectedSiteId = ownerIdOf(siteHit, 'siteId');
        } else if (unitHit && near === unitHit) {
          const unitId = ownerIdOf(unitHit, 'unitId');
          const unit = world.units.find(u => u.id === unitId);
          if (unit && unit.team === 'player' && unitId !== null) {
            ui.selectedBuildingId = null;
            ui.selectedSiteId = null;
            {
              const units = e.shiftKey ? [...selectedIds(world), unitId] : [unitId];
              issueCommand({ t: 'select', units }, () => cmdSetSelection(world, units));
            }
            followSelection();
          }
        } else if (bldHit && near === bldHit) {
          const bid = ownerIdOf(bldHit, 'buildingId');
          const b = world.buildings.find(x => x.id === bid);
          if (b && b.team === 'player') {
            issueCommand({ t: 'select', units: [] }, () => cmdSetSelection(world, []));
            followSelection();
            ui.selectedSiteId = null;
            ui.selectedBuildingId = bid;
          }
        } else {
          ui.selectedBuildingId = null;
          ui.selectedSiteId = null;
          issueCommand({ t: 'select', units: [] }, () => cmdSetSelection(world, []));
          followSelection();
        }
      }
      if (selboxEl) selboxEl.style.display = 'none';
      dragStart = null;
      dragging = false;
    }

    // ---- right: cancel placement / set rally / gather / move ----
    if (e.button === 2) {
      if (ui.placingType) { ui.placingType = null; ghost.hide(); return; }
      picker.setFromEvent(e);

      if (ui.selectedBuildingId !== null) {
        const groundHit = picker.ground();
        if (groundHit) {
          issueCommand(
            { t: 'rally', building: ui.selectedBuildingId, x: groundHit.point.x, z: groundHit.point.z },
            () => cmdSetRally(world, ui.selectedBuildingId as number, groundHit.point.x, groundHit.point.z),
          );
          commandFeedback(groundHit.point.x, groundHit.point.y, groundHit.point.z, 'rally');
          flash('rally point set');
        }
        return;
      }

      const sel = selectedIds(world);
      if (!sel.length) {
        const groundHit = picker.ground();
        if (groundHit) commandFeedback(groundHit.point.x, groundHit.point.y, groundHit.point.z, 'invalid');
        flash('select units before issuing an order');
        return;
      }

      // Hostile targets issue an attack-move toward the threat, so the units
      // engage what they meet on the way and close on the target itself.
      //
      // This used to issue a plain `cmdMove`, which sets `orderMode: 'move'` —
      // the one mode that deliberately never diverts, because a move order is a
      // destination the player named. The comment here claimed units would
      // "engage enemies they acquire along the route" and they would not: they
      // walked past everything to a fixed point and only ever fought whatever
      // happened to end up within 0.9 of them. The flash still said "attack
      // order". Right-click on an enemy is the gesture every RTS player reaches
      // for first, and it was the one gesture that could not attack.
      const hostileUnitHit = picker.unitDeep();
      const hostileBuildingHit = picker.buildingDeep();
      const hostile = [hostileUnitHit, hostileBuildingHit]
        .filter((hit): hit is THREE.Intersection => Boolean(hit))
        .sort((a, b) => a.distance - b.distance)[0];
      if (hostile) {
        const unitId = ownerIdOf(hostile, 'unitId');
        const buildingId = ownerIdOf(hostile, 'buildingId');
        const targetUnit = world.units.find(u => u.id === unitId && u.team !== 'player');
        const targetBuilding = world.buildings.find(b => b.id === buildingId && b.team !== 'player');
        const target = targetUnit ?? targetBuilding;
        if (target) {
          // Same command the A hotkey issues, so both routes to "attack that"
          // behave identically — including that only non-gatherers take the
          // attack-move mode, while workers in a mixed selection merely walk.
          issueCommand(
            { t: 'attackMove', units: sel, x: target.x, z: target.z },
            () => cmdAttackMove(world, sel, target.x, target.z),
          );
          commandFeedback(hostile.point.x, hostile.point.y, hostile.point.z, 'attack');
          flash(`attack — ${targetUnit ? targetUnit.type : 'enemy structure'}`);
          return;
        }
      }

      // resuming a paused build is the same gesture as starting one
      const siteHit = picker.siteDeep();
      if (siteHit) {
        const siteId = ownerIdOf(siteHit, 'siteId');
        if (siteId !== null) {
          const accepted = issueCommand(
            { t: 'assignBuilders', units: sel, site: siteId },
            () => cmdAssignBuilders(world, sel, siteId),
          );
          if (accepted.length) flash(`${accepted.length} worker(s) building`);
          else {
            commandFeedback(siteHit.point.x, siteHit.point.y, siteHit.point.z, 'invalid');
            flash('only workers can build');
          }
        }
        return;
      }

      const nodeHit = picker.nodeDeep();
      if (nodeHit) {
        const nodeId = ownerIdOf(nodeHit, 'nodeId');
        const node = world.nodes.find(n => n.id === nodeId);
        if (nodeId !== null) {
          // Workers gather; anything else just walks there.
          const accepted = new Set(issueCommand(
            { t: 'gather', units: sel, node: nodeId },
            () => cmdGather(world, sel, nodeId),
          ));
          const rest = sel.filter(id => !accepted.has(id));
          if (rest.length && node) issueCommand(
            { t: 'move', units: rest, x: node.x, z: node.z },
            () => cmdMove(world, rest, node.x, node.z),
          );
          commandFeedback(nodeHit.point.x, nodeHit.point.y, nodeHit.point.z, 'gather');
        }
        return;
      }

      const groundHit = picker.ground();
      if (groundHit) {
        issueCommand(
          { t: 'move', units: sel, x: groundHit.point.x, z: groundHit.point.z },
          () => cmdMove(world, sel, groundHit.point.x, groundHit.point.z),
        );
        commandFeedback(groundHit.point.x, groundHit.point.y, groundHit.point.z, 'move');
      }
    }
  });

  window.addEventListener('blur', () => { orbitLast = null; });
}
