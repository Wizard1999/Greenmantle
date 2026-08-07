import type { Team } from '../core/types';
import type { FogOfWarField, FogState } from './fogOfWar';

export type VisibilityMode = 'player' | 'omniscient';

export function visibilityModeFromSearch(search: string): VisibilityMode {
  const value = new URLSearchParams(search).get('vision');
  return value === 'omniscient' || value === 'spectator' ? 'omniscient' : 'player';
}

export interface VisibilityController {
  readonly fog: FogOfWarField;
  readonly mode: VisibilityMode;
  setMode: (mode: VisibilityMode) => void;
  toggle: () => VisibilityMode;
  stateAt: (x: number, z: number) => FogState;
  entityVisible: (team: Team, x: number, z: number) => boolean;
  resourceVisible: (x: number, z: number) => boolean;
  /** Has this ground ever been seen? Static features — terrain props — are
   *  remembered once explored, unlike entities, which must be currently in
   *  sight. A tree does not move; an army does. */
  terrainKnown: (x: number, z: number) => boolean;
}

/**
 * Presentation-only information policy. Deterministic simulation never reads
 * this controller: it decides what a local player, replay viewer, or spectator
 * is allowed to see and interact with.
 */
export function createVisibilityController(
  fog: FogOfWarField,
  initialMode: VisibilityMode = 'player',
): VisibilityController {
  let mode = initialMode;

  return {
    fog,
    get mode() { return mode; },
    setMode(next) { mode = next; },
    toggle() {
      mode = mode === 'player' ? 'omniscient' : 'player';
      return mode;
    },
    stateAt(x, z) {
      return mode === 'omniscient' ? 2 : fog.stateAt(x, z);
    },
    entityVisible(team, x, z) {
      return mode === 'omniscient' || team === 'player' || fog.stateAt(x, z) === 2;
    },
    resourceVisible(x, z) {
      return mode === 'omniscient' || fog.stateAt(x, z) > 0;
    },
    terrainKnown(x, z) {
      return mode === 'omniscient' || fog.stateAt(x, z) > 0;
    },
  };
}
