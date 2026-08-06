import type { EntityId } from './core/types';
import * as THREE from 'three';
import { createLoop } from './core/loop';
import { createWorld, simStep } from './sim/world';
import { buildTestMap } from './sim/map';
import { enableAi } from './sim/ai';
import { cmdCancelSite, cmdFormSquad, cmdHoldPosition, cmdSetSelection, cmdStop } from './sim/commands';
import { squadByNumber } from './sim/squads';
import { AUTOMATION } from './data/tuning';
import { createRenderer } from './render/renderer';
import { QUALITY, detectTier } from './render/quality';
import { updatePainterlyGlobals } from './render/painterly';
import { sampleSky } from './render/skyCycle';
import { buildTerrainMesh } from './render/terrainMesh';
import { buildSceneryViews } from './render/sceneryViews';
import { buildNodeViews, syncNodeViews } from './render/nodeViews';
import { syncBuildingViews } from './render/buildingViews';
import { syncUnitViews } from './render/unitViews';
import { syncSiteViews } from './render/siteViews';
import { createCamera } from './render/camera';
import { createPlacementGhost } from './render/placementGhost';
import { createChainVisuals } from './render/chainVisuals';
import { createCommandFeedback } from './render/commandFeedback';
import { createPicker, createUiState } from './input/selection';
import { createKeyboard } from './input/keyboard';
import { createMouse } from './input/mouse';
import { createHud } from './ui/hud';
import { createResearchPanel } from './ui/researchPanel';
import { createChainEditor } from './ui/chainEditor';
import { createSandbox } from './dev/sandbox';
import { mountBuildBadge } from './ui/buildBadge';
import { mountQualityControl } from './ui/qualityControl';
import { createMinimap } from './ui/minimap';
import { mountMapSeedControl } from './ui/mapSeedControl';
import { FogOfWarField, playerVisionSources } from './ui/fogOfWar';
import { createVisibilityController, visibilityModeFromSearch } from './ui/visibility';
import { createFogOverlay } from './render/fogOverlay';
import { createTutorial } from './ui/tutorial';
import { mountControlsSheet } from './ui/controlsSheet';
import { Recorder } from './sim/replay';
import { configureLiveRecording, issueCommand } from './replay/live';

void mountBuildBadge();
// Before anything that mounts into it: the sheet hosts the settings block that
// `mountQualityControl` looks for, and the `?` binding a player may hit at once.
mountControlsSheet();

// Opt in to the opponent explicitly — a bare world is inert (see sim/world.ts).
const MATCH_SEED = 1337;
const MATCH_START_HOUR = 8;
const requestedMapSeed = Number(new URLSearchParams(window.location.search).get('mapSeed'));
const MAP_SEED = Number.isSafeInteger(requestedMapSeed) ? requestedMapSeed : MATCH_SEED;
const world = enableAi(buildTestMap(createWorld(MATCH_SEED, MATCH_START_HOUR, MAP_SEED)));
const recorder = new Recorder(MATCH_SEED, MATCH_START_HOUR, MAP_SEED, 'standardAi');
configureLiveRecording(world, recorder);

// Hoisted: the render callback ran `new THREE.Color(0x000000)` every frame,
// allocating a throwaway object 60 times a second for a constant.
const VOID_BACKGROUND = new THREE.Color(0x000000);

const quality = QUALITY[detectTier()];
mountQualityControl(quality.tier);
mountMapSeedControl(MAP_SEED);
const { scene, renderer, sun } = createRenderer(quality);
const terrainPresentation = buildTerrainMesh(scene, quality, world.mapSeed);
const terrainMesh = terrainPresentation.mesh;
const fog = new FogOfWarField(terrainPresentation.boundary);
const visibility = createVisibilityController(fog, visibilityModeFromSearch(window.location.search));
const fogOverlay = createFogOverlay(scene, fog, visibility);
const sceneryViews = buildSceneryViews(scene, world);

const views = {
  units: new Map<EntityId, THREE.Group>(),
  buildings: new Map<EntityId, THREE.Group>(),
  sites: new Map<EntityId, THREE.Group>(),
  nodes: buildNodeViews(scene, world),
};

const cam = createCamera(terrainMesh, terrainPresentation.boundary);
const ghost = createPlacementGhost(scene);
const ui = createUiState();
const picker = createPicker(cam.camera, terrainMesh, views);
const hud = createHud(world, ui);
const researchPanel = createResearchPanel(world, hud.flash);
const chainEditor = createChainEditor(world, ui, hud.flash);
const chainVisuals = createChainVisuals(scene);
const commandFeedback = createCommandFeedback(scene);
const minimap = createMinimap(world, terrainPresentation.boundary, cam, fog, visibility);
const tutorial = createTutorial(world, ui);

createMouse({
  world, domElement: renderer.domElement, cam, picker, ghost, ui, flash: hud.flash,
  commandFeedback: commandFeedback.show,
});

const keyboard = createKeyboard({
  onKey(k, e) {
    // Ctrl+1..5 forms a squad; 1..5 selects one. Squads are persistent (Q1),
    // so the number key is a real handle, not a saved selection.
    const n = Number(k);
    if (Number.isInteger(n) && n >= 1 && n <= AUTOMATION.maxSquads) {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const sel = world.units.filter(u => u.selected && u.team === 'player').map(u => u.id);
        const res = issueCommand(
          { t: 'formSquad', team: 'player', units: sel, number: n },
          () => cmdFormSquad(world, 'player', sel, n),
        );
        if (res.ok) {
          ui.selectedSquadId = res.siteId ?? null;
          ui.armedBehaviour = null;
          hud.flash(`squad ${n} formed — ${sel.length} unit(s)`);
        } else {
          hud.flash(res.reason ?? 'cannot form a squad');
        }
      } else {
        const squad = squadByNumber(world, 'player', n);
        if (squad) {
          ui.selectedSquadId = squad.id;
          ui.armedBehaviour = null;
          ui.selectedBuildingId = null;
          ui.selectedSiteId = null;
          issueCommand(
            { t: 'select', units: squad.memberIds },
            () => cmdSetSelection(world, squad.memberIds),
          );
        } else {
          hud.flash(`no squad ${n} — select units and press Ctrl+${n}`);
        }
      }
      return;
    }

    if (k === 'a') {
      e.preventDefault();
      const units = world.units.filter(u => u.selected && u.team === 'player' && !u.gather).map(u => u.id);
      if (!units.length) hud.flash('select combat units first');
      else { ui.armedOrder = 'attackMove'; ui.armedBehaviour = null; hud.flash('attack-move armed — click the battlefield'); }
      return;
    }
    if (k === 'p') {
      e.preventDefault();
      const units = world.units.filter(u => u.selected && u.team === 'player').map(u => u.id);
      if (!units.length) hud.flash('select units first');
      else { ui.armedOrder = 'patrol'; ui.armedBehaviour = null; hud.flash('patrol armed — click the battlefield'); }
      return;
    }
    if (k === 's') {
      e.preventDefault();
      const units = world.units.filter(u => u.selected && u.team === 'player').map(u => u.id);
      if (units.length) { issueCommand({ t: 'stop', units }, () => cmdStop(world, units)); hud.flash('orders stopped'); }
      return;
    }
    if (k === 'h') {
      e.preventDefault();
      const units = world.units.filter(u => u.selected && u.team === 'player').map(u => u.id);
      if (units.length) { issueCommand({ t: 'hold', units }, () => cmdHoldPosition(world, units)); hud.flash('holding position'); }
      return;
    }

    if (k === 'home') {
      e.preventDefault();
      cam.frameBoard();
      tutorial.notify('frameBoard');
      hud.flash('whole board framed');
    }
    if (k === 't') loop.setThrottle(!loop.isThrottled());
    if (k === 'g') {
      ui.selectedBuildingId = null;
      ui.selectedSiteId = null;
      {
        const units = world.units.filter(u => u.team === 'player' && u.gather).map(u => u.id);
        issueCommand({ t: 'select', units }, () => cmdSetSelection(world, units));
      }
    }
    if (k === 'escape') {
      if (ui.armedOrder) { ui.armedOrder = null; }
      else if (ui.armedBehaviour) { ui.armedBehaviour = null; }
      else if (ui.placingType) { ui.placingType = null; ghost.hide(); }
      else if (ui.selectedSiteId !== null) {
        issueCommand(
          { t: 'cancelSite', site: ui.selectedSiteId },
          () => cmdCancelSite(world, ui.selectedSiteId as number),
        );
        ui.selectedSiteId = null;
        hud.flash('site cancelled, essence refunded');
      }
    }
    if (k === 'b' && world.units.some(u => u.selected && u.gather)) ui.placingType = 'outpost';
    if (k === 'q') hud.tryTrain('worker');
    if (k === 'e') hud.tryTrain('legionnaire');
    if (k === 'r') hud.tryTrain('marksman');
  },
});

window.addEventListener('resize', () => {
  cam.onResize();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const loop = createLoop({
  step: () => simStep(world),
  render: (alpha, realDt, now) => {
    // Drive the whole sky from the sim clock, so what the player sees and
    // what a replay records are the same time of day.
    const sky = sampleSky(world);
    // Seconds, not the raw rAF timestamp: the drift constants are per-second,
    // and feeding milliseconds pushed the cloud-noise hash past float32
    // precision within seconds of load, flickering the whole ground.
    updatePainterlyGlobals(now / 1000, quality.cloudShadows ? 0.28 * sky.light : 0, sky);
    sun.position.copy(sky.sunDir).multiplyScalar(60);
    sun.color.copy(sky.sunColor);
    sun.intensity = 0.35 + sky.light * 1.65;
    // The terrain is a physical table suspended in an unlit void. Day/night
    // still drives surface lighting, but never paints a conventional sky dome.
    scene.background = VOID_BACKGROUND;
    renderer.toneMappingExposure = 0.85 + sky.light * 0.3;
    cam.pan(realDt, keyboard.keys, keyboard.mouseX, keyboard.mouseY);
    cam.update();
    fog.update(playerVisionSources(world));
    fogOverlay.update();
    const squadMemberIds = new Set(world.squads.flatMap(s => s.memberIds));
    syncUnitViews(scene, world, views.units, alpha, squadMemberIds, cam.camera, quality.tier, visibility);
    syncNodeViews(world, views.nodes, visibility);
    syncSiteViews(scene, world, views.sites, visibility);
    syncBuildingViews(scene, world, views.buildings, ui.selectedBuildingId, cam.camera, quality.tier, visibility);
    sceneryViews.sync(cam.camera, quality.tier);
    terrainPresentation.update(cam.camera);
    chainVisuals.sync(world.squads.find(s => s.id === ui.selectedSquadId) ?? null);
    commandFeedback.update(realDt);
    hud.update(now, loop.isThrottled());
    researchPanel.update();
    chainEditor.update();
    sandbox.update(now);
    minimap.update();
    tutorial.update();
    renderer.render(scene, cam.camera);
  },
});

const sandbox = createSandbox({ world, loop, camera: cam, renderer, ui, scene, quality, recorder, visibility });
cam.update();
loop.start();

/**
 * Automation handle for the screenshot harness (`npm run capture`).
 *
 * Gated behind `?capture=1` so it cannot exist in a build a player loads —
 * a global that hands out the mutable `World` is a cheat console otherwise.
 * Deliberately not `?dev=`: the sandbox is a human tool with its own panel, and
 * conflating the two means a change to one silently alters the other.
 *
 * Everything here is read-or-drive, never a new capability: `loop` already
 * exposes pause/step publicly so the sandbox can single-tick, and the camera is
 * driven through the same `focusAt`/`orbit` calls the mouse uses. The harness
 * therefore photographs the real game rather than a special rendering path.
 */
if (new URLSearchParams(window.location.search).has('capture')) {
  (window as unknown as { __greenmantle?: unknown }).__greenmantle = {
    world, loop, cam, quality, ui, renderer,
  };
}
