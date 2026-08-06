import { describe, expect, it } from 'vitest';
import { CONTROL_GROUPS, allBindings } from '../src/ui/controlsSheet';

/**
 * The control reference replaced a permanently-open keybinding wall (D-032).
 * That trade is only honest if nothing was lost in the move, so these tests
 * assert coverage against the bindings `input/keyboard.ts` actually handles.
 * If a hotkey is added there and not here, the sheet silently stops being the
 * complete reference it claims to be.
 */

const keysIn = (text: string): boolean =>
  allBindings().some(b => b.keys.some(k => k.toLowerCase() === text.toLowerCase()));

describe('control reference', () => {
  it('covers every hotkey the keyboard layer binds', () => {
    // Mirrors src/input/keyboard.ts + main.ts onKey.
    for (const key of ['A', 'P', 'S', 'H', 'B', 'Q', 'E', 'R', 'G', 'T', 'Home', 'Esc']) {
      expect(keysIn(key), `missing binding for ${key}`).toBe(true);
    }
  });

  it('explains squad formation and selection', () => {
    const text = allBindings().map(b => `${b.keys.join(' ')} ${b.what}`).join('\n').toLowerCase();
    expect(text).toContain('squad');
    expect(text).toContain('ctrl');
  });

  it('tells the player how to reopen it', () => {
    expect(keysIn('?')).toBe(true);
  });

  it('names no internal milestone', () => {
    const text = JSON.stringify(CONTROL_GROUPS);
    expect(text).not.toMatch(/phase\s*\d/i);
  });

  it('groups bindings by intent rather than listing one flat wall', () => {
    expect(CONTROL_GROUPS.length).toBeGreaterThanOrEqual(4);
    for (const group of CONTROL_GROUPS) {
      expect(group.title.length).toBeGreaterThan(0);
      expect(group.bindings.length).toBeGreaterThan(0);
      for (const binding of group.bindings) {
        expect(binding.keys.length).toBeGreaterThan(0);
        expect(binding.what.length).toBeGreaterThan(0);
      }
    }
  });
});
