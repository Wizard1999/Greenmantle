/**
 * The frame/tick readout — developer scaffolding, gated behind `?dev=`.
 *
 * It used to ship in `index.html` unconditionally, so every player's first
 * screen carried render fps, sim ticks/s, a raw tick counter and essence/min in
 * a monospace terminal box. The numbers are genuinely useful — they are how
 * D-006's performance target gets checked and how a throttle test is read — so
 * this deletes nothing. It moves the panel behind the same gate the sandbox
 * already uses, and builds its DOM from here rather than from the page, which
 * is what makes the gate impossible to forget: with no `?dev=` there is no
 * element to leak.
 *
 * `createDebugReadout` always returns a working object. The no-op branch keeps
 * `hud.ts` free of `if (debug)` at every call site, so the sampling code has one
 * shape whether or not anyone is watching.
 */

export interface DebugMetrics {
  fps: number;
  ticksPerSecond: number;
  tickRateOk: boolean;
  tick: number;
  essencePerMinute: number;
  units: number;
  selected: number;
  throttled: boolean;
}

export interface DebugReadout {
  /** True when the panel exists; false in a player build. */
  readonly active: boolean;
  /** Cheap, frequent values. Safe to call every frame. */
  live: (metrics: Pick<DebugMetrics, 'tick' | 'units' | 'selected' | 'throttled'>) => void;
  /** Sampled values, updated on the hud's own half-second cadence. */
  sampled: (metrics: Pick<DebugMetrics, 'fps' | 'ticksPerSecond' | 'tickRateOk' | 'essencePerMinute'>) => void;
}

const INERT: DebugReadout = {
  active: false,
  live: () => undefined,
  sampled: () => undefined,
};

const ROWS = [
  ['fps', 'render fps'],
  ['tps', 'sim ticks/s'],
  ['tick', 'tick'],
  ['rate', 'essence/min'],
  ['units', 'units'],
  ['sel', 'selected'],
  ['throttle', 'throttle'],
] as const;

/** True when the developer scaffolding is requested by the URL. */
export function devRequested(search: string): boolean {
  return new URLSearchParams(search).has('dev');
}

export function createDebugReadout(search = window.location.search): DebugReadout {
  if (!devRequested(search)) return INERT;

  const panel = document.createElement('div');
  panel.id = 'debug';
  panel.className = 'panel';

  const heading = document.createElement('h4');
  heading.textContent = 'Debug';
  panel.appendChild(heading);

  const value: Record<string, HTMLElement> = {};
  for (const [key, label] of ROWS) {
    const row = document.createElement('div');
    row.className = 'row';
    const k = document.createElement('span');
    k.className = 'k';
    k.textContent = label;
    const v = document.createElement('span');
    v.textContent = '—';
    row.append(k, v);
    panel.appendChild(row);
    value[key] = v;
  }
  document.body.appendChild(panel);

  const set = (key: string, text: string, warn = false): void => {
    const node = value[key];
    if (!node) return;
    node.textContent = text;
    node.className = warn ? 'warn' : '';
  };

  return {
    active: true,
    live: (m) => {
      set('tick', String(m.tick));
      set('units', String(m.units));
      set('sel', String(m.selected));
      set('throttle', m.throttled ? 'ON (~12fps)' : 'off', m.throttled);
    },
    sampled: (m) => {
      set('fps', m.fps.toFixed(0));
      set('tps', m.ticksPerSecond.toFixed(1), !m.tickRateOk);
      set('rate', m.essencePerMinute.toFixed(0));
    },
  };
}
