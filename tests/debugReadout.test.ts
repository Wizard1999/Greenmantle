import { describe, expect, it } from 'vitest';
import { devRequested } from '../src/ui/debugReadout';

/**
 * The debug readout shipped unconditionally in the player build (D-032). The
 * gate is one predicate, so test the predicate directly — the DOM branch is
 * unreachable when this returns false.
 */
describe('debug readout gate', () => {
  it('stays closed for a player', () => {
    expect(devRequested('')).toBe(false);
    expect(devRequested('?capture=1')).toBe(false);
    expect(devRequested('?tutorial=1&mapSeed=42')).toBe(false);
    expect(devRequested('?development=1')).toBe(false);
  });

  it('opens for every ?dev= mode, and for a bare ?dev', () => {
    expect(devRequested('?dev')).toBe(true);
    expect(devRequested('?dev=camera')).toBe(true);
    expect(devRequested('?dev=performance&quality=low')).toBe(true);
    expect(devRequested('?mapSeed=3&dev=battle')).toBe(true);
  });
});
