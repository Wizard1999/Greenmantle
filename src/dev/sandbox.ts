import * as THREE from 'three';
import type { World } from '../core/types';
import { TICK_HZ, type Loop } from '../core/loop';
import type { RtsCamera } from '../render/camera';
import type { UiState } from '../input/selection';
import { spawnSquad, spawnUnit } from '../sim/entities';
import { createDiagnosticVisuals } from './diagnosticVisuals';
import { PerformanceMonitor, downloadPerformanceReport } from './performanceMonitor';
import type { QualitySettings } from '../render/quality';
import { createSave, loadSave, parseSave, serializeSave } from '../sim/save';
import type { Recorder } from '../sim/replay';
import { parseReplay, serializeReplay, verifyReplay } from '../sim/replay';
import { restore } from '../sim/snapshot';
import { ReplayTimeline } from '../replay/timeline';
import type { VisibilityController } from '../ui/visibility';

export type SandboxMode = 'camera' | 'battle' | 'units' | 'economy' | 'performance';

export interface Sandbox {
  enabled: boolean;
  mode: SandboxMode;
  update: (now: number) => void;
}

const QUICK_SAVE_KEY = 'longbarrow.dev.quicksave';

function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function saveFilename(world: World): string {
  return `longbarrow-save-t${world.tick}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
}

export interface SandboxOptions {
  world: World;
  loop: Loop;
  camera: RtsCamera;
  renderer: THREE.WebGLRenderer;
  ui: UiState;
  scene: THREE.Scene;
  quality: QualitySettings;
  recorder: Recorder;
  visibility: VisibilityController;
}

function modeFromUrl(): SandboxMode {
  const raw = new URLSearchParams(window.location.search).get('dev');
  if (raw === 'battle' || raw === 'units' || raw === 'economy' || raw === 'performance') return raw;
  return 'camera';
}

function selectedSummary(world: World): string {
  const selected = world.units.filter(unit => unit.selected);
  if (selected.length === 0) return 'selection: none';
  if (selected.length > 1) {
    const hp = selected.reduce((sum, unit) => sum + unit.hp, 0);
    return `selection: ${selected.length} units · ${Math.round(hp)} total hp`;
  }

  const unit = selected[0];
  if (!unit) return 'selection: none';
  const order = unit.targetId !== null
    ? `attacking #${unit.targetId}`
    : unit.target
      ? `moving ${unit.target.x.toFixed(1)}, ${unit.target.z.toFixed(1)}`
      : unit.gather && unit.gather.state !== 'idle'
        ? `${unit.gather.state}${unit.gather.nodeId === null ? '' : ` #${unit.gather.nodeId}`}`
        : unit.build?.siteId !== null && unit.build?.siteId !== undefined
          ? `building #${unit.build.siteId}`
          : 'idle';
  return `#${unit.id} ${unit.type} · hp ${Math.round(unit.hp)} · ${order}`;
}

function seedScenario(world: World, mode: SandboxMode): void {
  if (mode === 'camera') return;
  if (mode === 'battle') {
    spawnSquad(world, 'legionnaire', 'player', -12, 0, 10);
    spawnSquad(world, 'marksman', 'player', -15, 5, 6);
    spawnSquad(world, 'legionnaire', 'rival', 12, 0, 10);
    spawnSquad(world, 'marksman', 'rival', 15, 5, 6);
  } else if (mode === 'units') {
    spawnSquad(world, 'legionnaire', 'player', -8, 0, 5);
    spawnSquad(world, 'marksman', 'player', 0, 0, 5);
    for (let i = 0; i < 4; i++) spawnUnit(world, 'worker', 'player', 8 + i * 1.5, 0);
  } else if (mode === 'economy') {
    for (let i = 0; i < 8; i++) spawnUnit(world, 'worker', 'player', -12 + i * 1.4, 8);
    world.resources.player += 500;
  } else if (mode === 'performance') {
    for (let row = 0; row < 5; row++) {
      spawnSquad(world, row % 2 ? 'marksman' : 'legionnaire', 'player', -24, -16 + row * 8, 20);
      spawnSquad(world, row % 2 ? 'legionnaire' : 'marksman', 'rival', 24, -16 + row * 8, 20);
    }
  }
}

export function createSandbox(options: SandboxOptions): Sandbox {
  const { world, loop, camera, renderer, ui, scene, quality, recorder, visibility } = options;
  const params = new URLSearchParams(window.location.search);
  const enabled = params.has('dev');
  const mode = modeFromUrl();
  if (!enabled) return { enabled, mode, update: () => undefined };
  document.body.classList.add('dev-mode');

  const panel = document.createElement('aside');
  panel.id = 'dev-sandbox';
  // Shares the one panel language (D-032) rather than carrying its own chrome.
  panel.className = 'panel';
  panel.innerHTML = `
    <h3>Developer Sandbox</h3>
    <div class="dev-mode">Mode: <b>${mode}</b></div>
    <div class="dev-row">
      <button data-action="pause">Pause</button>
      <button data-action="step">Step 1 tick</button>
      <button data-action="seed">Load preset</button>
    </div>
    <div class="dev-row">
      <button data-speed="0.25">0.25×</button>
      <button data-speed="1">1×</button>
      <button data-speed="2">2×</button>
      <button data-speed="4">4×</button>
    </div>
    <div class="dev-row">
      <button data-spawn="player">+ Player squad</button>
      <button data-spawn="rival">+ Rival squad</button>
    </div>
    <div class="dev-row">
      <button data-action="worker">+ Worker</button>
      <button data-action="clear">Clear loose units</button>
    </div>
    <div class="dev-row">
      <button data-toggle="orders">Orders: off</button>
      <button data-toggle="radii">Radii: off</button>
      <button data-toggle="vision">Vision: ${visibility.mode}</button>
    </div>
    <div class="dev-row">
      <button data-action="quick-save">Quick save</button>
      <button data-action="quick-load">Quick load</button>
      <button data-action="save-export">Export save</button>
      <button data-action="save-import">Import save</button>
    </div>
    <div class="dev-row">
      <button data-action="replay-export">Export replay</button>
      <button data-action="replay-verify">Verify replay</button>
      <button data-action="replay-view-current">Open viewer</button>
      <button data-action="replay-import">Import replay</button>
    </div>
    <section class="dev-replay" data-role="replay-controls" hidden>
      <div class="dev-row">
        <button data-replay-nav="start">|&lt;</button>
        <button data-replay-nav="back">-10s</button>
        <button data-replay-nav="play">Play</button>
        <button data-replay-nav="forward">+10s</button>
        <button data-replay-nav="end">&gt;|</button>
      </div>
      <label class="dev-timeline-label">Replay tick <output data-role="replay-tick">0</output>
        <input data-role="replay-timeline" type="range" min="0" max="0" value="0" step="1">
      </label>
    </section>
    <div class="dev-row">
      <button data-action="benchmark-reset">Reset benchmark</button>
      <button data-action="benchmark-export">Export report</button>
    </div>
    <input data-role="save-file" type="file" accept="application/json,.json" hidden>
    <input data-role="replay-file" type="file" accept="application/json,.json" hidden>
    <pre class="dev-readout" aria-live="polite"></pre>
    <small>Modes: ?dev=camera, battle, units, economy, or performance.</small>
  `;
  document.body.appendChild(panel);

  const pauseButton = panel.querySelector<HTMLButtonElement>('[data-action="pause"]');
  const readout = panel.querySelector<HTMLElement>('.dev-readout');
  const saveFileInput = panel.querySelector<HTMLInputElement>('[data-role="save-file"]');
  const replayFileInput = panel.querySelector<HTMLInputElement>('[data-role="replay-file"]');
  const replayControls = panel.querySelector<HTMLElement>('[data-role="replay-controls"]');
  const replayTimelineInput = panel.querySelector<HTMLInputElement>('[data-role="replay-timeline"]');
  const replayTickOutput = panel.querySelector<HTMLOutputElement>('[data-role="replay-tick"]');
  let saveStatus = 'save: none';
  let replayStatus = 'replay: recording';
  let replayTimeline: ReplayTimeline | null = null;
  let replayTick = 0;
  let replayPlaying = false;
  let replayClock = 0;
  let seeded = false;
  let frames = 0;
  let lastSample = performance.now();
  let fps = 0;
  let showOrders = false;
  let showRadii = false;
  const diagnosticVisuals = createDiagnosticVisuals(scene);
  const performanceMonitor = new PerformanceMonitor();

  function showReplay(replay: ReturnType<Recorder['finish']>, startAtEnd = false): void {
    replayTimeline = new ReplayTimeline(replay);
    replayTick = startAtEnd ? replayTimeline.endTick : 0;
    replayPlaying = false;
    replayClock = 0;
    if (replayControls) replayControls.hidden = false;
    if (replayTimelineInput) {
      replayTimelineInput.max = String(replayTimeline.endTick);
      replayTimelineInput.value = String(replayTick);
    }
    restore(world, replayTimeline.seek(replayTick));
    visibility.setMode('omniscient');
    loop.setPaused(true);
    recorder.invalidate('replay viewer opened');
    ui.selectedSquadId = null;
    ui.selectedBuildingId = null;
    ui.selectedSiteId = null;
    replayStatus = `replay viewer: tick ${replayTick}/${replayTimeline.endTick}`;
  }

  function seekReplay(nextTick: number): void {
    if (!replayTimeline) return;
    replayTick = Math.max(0, Math.min(replayTimeline.endTick, Math.floor(nextTick)));
    restore(world, replayTimeline.seek(replayTick));
    if (replayTimelineInput) replayTimelineInput.value = String(replayTick);
    if (replayTickOutput) replayTickOutput.value = String(replayTick);
    replayStatus = `replay viewer: tick ${replayTick}/${replayTimeline.endTick}`;
  }

  panel.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!button) return;
    const speed = button.dataset['speed'];
    const spawn = button.dataset['spawn'];
    const action = button.dataset['action'];
    const toggle = button.dataset['toggle'];
    const replayNav = button.dataset['replayNav'];

    if (speed) loop.setSpeed(Number(speed));
    if (spawn === 'player') spawnSquad(world, 'legionnaire', 'player', -10, 2, 8);
    if (spawn === 'rival') spawnSquad(world, 'legionnaire', 'rival', 10, 2, 8);
    if (action === 'pause') loop.setPaused(!loop.isPaused());
    if (action === 'step') { loop.setPaused(true); loop.stepOnce(); }
    if (action === 'seed' && !seeded) { seedScenario(world, mode); seeded = true; }
    if (action === 'worker') spawnUnit(world, 'worker', 'player', -12, 8);
    if (action === 'quick-save') {
      localStorage.setItem(QUICK_SAVE_KEY, serializeSave(createSave(world, new Date().toISOString())));
      saveStatus = `save: quick-saved tick ${world.tick}`;
    }
    if (action === 'quick-load') {
      const text = localStorage.getItem(QUICK_SAVE_KEY);
      if (!text) {
        saveStatus = 'save: no quick save found';
      } else {
        try {
          loadSave(world, parseSave(text));
          recorder.invalidate('a save state was loaded');
          ui.selectedSquadId = null;
          ui.selectedBuildingId = null;
          ui.selectedSiteId = null;
          saveStatus = `save: loaded tick ${world.tick}`;
        } catch (error) {
          saveStatus = `save: ${error instanceof Error ? error.message : 'load failed'}`;
        }
      }
    }
    if (action === 'save-export') {
      downloadText(saveFilename(world), serializeSave(createSave(world, new Date().toISOString())));
      saveStatus = `save: exported tick ${world.tick}`;
    }
    if (action === 'save-import') saveFileInput?.click();
    if (action === 'replay-import') replayFileInput?.click();
    if (action === 'replay-view-current') {
      try {
        showReplay(recorder.finish(world), false);
      } catch (error) {
        replayStatus = `replay: ${error instanceof Error ? error.message : 'viewer failed'}`;
      }
    }
    if (action === 'replay-export') {
      try {
        const replay = recorder.finish(world);
        downloadText(`longbarrow-replay-t${world.tick}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, serializeReplay(replay));
        replayStatus = `replay: exported ${replay.commands.length} commands at tick ${world.tick}`;
      } catch (error) {
        replayStatus = `replay: ${error instanceof Error ? error.message : 'export failed'}`;
      }
    }
    if (action === 'replay-verify') {
      try {
        const replay = recorder.finish(world);
        const result = verifyReplay(replay);
        replayStatus = result.ok
          ? `replay: verified ${replay.commands.length} commands through tick ${world.tick}`
          : `replay: ${result.reason ?? 'verification failed'}`;
      } catch (error) {
        replayStatus = `replay: ${error instanceof Error ? error.message : 'verification failed'}`;
      }
    }
    if (action === 'benchmark-reset') performanceMonitor.reset();
    if (action === 'benchmark-export') {
      downloadPerformanceReport(performanceMonitor.report(renderer, world, quality));
    }
    if (toggle === 'orders') {
      showOrders = !showOrders;
      button.textContent = `Orders: ${showOrders ? 'on' : 'off'}`;
    }
    if (toggle === 'radii') {
      showRadii = !showRadii;
      button.textContent = `Radii: ${showRadii ? 'on' : 'off'}`;
    }
    if (toggle === 'vision') {
      const mode = visibility.toggle();
      button.textContent = `Vision: ${mode}`;
    }
    if (replayNav === 'start') seekReplay(0);
    if (replayNav === 'back') seekReplay(replayTick - 10 * TICK_HZ);
    if (replayNav === 'forward') seekReplay(replayTick + 10 * TICK_HZ);
    if (replayNav === 'end' && replayTimeline) seekReplay(replayTimeline.endTick);
    if (replayNav === 'play' && replayTimeline) {
      replayPlaying = !replayPlaying;
      replayClock = 0;
      button.textContent = replayPlaying ? 'Pause replay' : 'Play';
    }
    if (action === 'clear') {
      world.units = world.units.filter(unit => unit.gather !== null);
      ui.selectedSquadId = null;
    }
  });


  saveFileInput?.addEventListener('change', async () => {
    const file = saveFileInput.files?.[0];
    if (!file) return;
    try {
      loadSave(world, parseSave(await file.text()));
      recorder.invalidate('a save state was imported');
      ui.selectedSquadId = null;
      ui.selectedBuildingId = null;
      ui.selectedSiteId = null;
      saveStatus = `save: imported tick ${world.tick}`;
    } catch (error) {
      saveStatus = `save: ${error instanceof Error ? error.message : 'import failed'}`;
    } finally {
      saveFileInput.value = '';
    }
  });


  replayFileInput?.addEventListener('change', async () => {
    const file = replayFileInput.files?.[0];
    if (!file) return;
    try {
      const replay = parseReplay(await file.text());
      if (replay.endTick === undefined) throw new Error('replay has no recorded endpoint');
      const verification = verifyReplay(replay);
      if (!verification.ok) throw new Error(verification.reason ?? 'replay verification failed');
      showReplay(replay, false);
      replayStatus = `replay: imported and verified · ${replay.commands.length} commands`;
    } catch (error) {
      replayStatus = `replay: ${error instanceof Error ? error.message : 'import failed'}`;
    } finally {
      replayFileInput.value = '';
    }
  });

  replayTimelineInput?.addEventListener('input', () => {
    replayPlaying = false;
    seekReplay(Number(replayTimelineInput.value));
  });

  return {
    enabled,
    mode,
    update: now => {
      if (replayPlaying && replayTimeline) {
        if (replayClock === 0) replayClock = now;
        const elapsedTicks = Math.floor((now - replayClock) / (1000 / TICK_HZ));
        if (elapsedTicks > 0) {
          replayClock += elapsedTicks * (1000 / TICK_HZ);
          seekReplay(replayTick + elapsedTicks);
          if (replayTick >= replayTimeline.endTick) replayPlaying = false;
        }
      }
      frames++;
      performanceMonitor.sample(now);
      if (now - lastSample >= 500) {
        fps = frames / ((now - lastSample) / 1000);
        frames = 0;
        lastSample = now;
      }
      diagnosticVisuals.sync(world, showOrders, showRadii);
      if (replayTickOutput) replayTickOutput.value = String(replayTick);
      if (pauseButton) pauseButton.textContent = loop.isPaused() ? 'Resume' : 'Pause';
      if (readout) {
        const state = camera.state;
        const info = renderer.info;
        const benchmark = performanceMonitor.summary();
        readout.textContent = [
          `tick ${world.tick} · ${loop.getSpeed()}×${loop.isPaused() ? ' · PAUSED' : ''}`,
          `fps ${fps.toFixed(0)} · calls ${info.render.calls} · tris ${info.render.triangles.toLocaleString()}`,
          `benchmark ${quality.label} · avg ${benchmark.averageFps.toFixed(1)} fps · p95 ${benchmark.p95FrameMs.toFixed(1)} ms · ${benchmark.sampleCount} frames`,
          `units ${world.units.length} · buildings ${world.buildings.length} · sites ${world.sites.length}`,
          `camera ${state.focusX.toFixed(1)}, ${state.focusZ.toFixed(1)} · yaw ${THREE.MathUtils.radToDeg(state.yaw).toFixed(0)}° · pitch ${THREE.MathUtils.radToDeg(state.pitch).toFixed(0)}° · zoom ${state.distance.toFixed(1)}`,
          selectedSummary(world),
          `overlays orders ${showOrders ? 'on' : 'off'} · radii ${showRadii ? 'on' : 'off'}`,
          saveStatus,
          `${replayStatus} · ${recorder.length} command(s)`,
        ].join('\n');
      }
    },
  };
}
