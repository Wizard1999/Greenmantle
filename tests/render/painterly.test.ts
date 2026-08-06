import { describe, expect, it } from 'vitest';
import { cloudOffset } from '../../src/render/painterly';

/**
 * Guards a units bug that shipped and was visible in every match.
 *
 * `updatePainterlyGlobals` was called with `performance.now()` — milliseconds —
 * while the drift constants are per-second. The cloud-shadow offset therefore
 * grew about a thousand times too fast, and `hash21`'s opening
 * `fract(p * vec2(123.34, 456.21))` lost its fractional bits to float32
 * precision. The hash returned quantised noise that reshuffled every frame and
 * the entire ground pulsed.
 *
 * Nothing about that failure was catchable by a type: both quantities are a
 * bare `number`. So assert the magnitude instead — the offset over a realistic
 * session has to stay in the range where a float32 `fract()` still means
 * something.
 */
describe('cloud shadow drift', () => {
  /*
   * Where the cliff actually is, rather than a round number.
   *
   * A float32 carries a 24-bit mantissa, so relative precision is 2^-24 ≈
   * 6e-8 and the absolute step at magnitude v is about v * 6e-8. For `fract(v)`
   * to still resolve to ~1e-2 — the coarsest that reads as smooth drift rather
   * than steps — v must stay under roughly 1.6e5.
   *
   * The shipped bug ran at ~1.8e6 ten minutes into a match, an order of
   * magnitude past that, which is why it flickered rather than merely
   * stuttering. One hour of correct seconds lands at ~1.1e4: a resolution of
   * about 6e-4, three usable fractional digits.
   */
  const PRECISION_CEILING = 1.6e5;
  const LARGEST_HASH_MULTIPLIER = 456.21;

  it('stays inside float32 fract() precision across a long match', () => {
    const oneHour = 60 * 60;
    const { x, z } = cloudOffset(oneHour);
    expect(Math.abs(x * LARGEST_HASH_MULTIPLIER)).toBeLessThan(PRECISION_CEILING);
    expect(Math.abs(z * LARGEST_HASH_MULTIPLIER)).toBeLessThan(PRECISION_CEILING);
  });

  it('still resolves finely an hour in, not merely within the ceiling', () => {
    const { x } = cloudOffset(60 * 60);
    const absoluteStep = Math.abs(x * LARGEST_HASH_MULTIPLIER) * 2 ** -24;
    expect(absoluteStep).toBeLessThan(1e-3);
  });

  it('stays bounded even if a tab is left open for days', () => {
    const oneWeek = 7 * 24 * 60 * 60;
    const { x, z } = cloudOffset(oneWeek);
    expect(Number.isFinite(x)).toBe(true);
    expect(Number.isFinite(z)).toBe(true);
    expect(Math.abs(x * 456.21)).toBeLessThan(1e7);
    expect(Math.abs(z * 456.21)).toBeLessThan(1e7);
  });

  it('drifts — a static field would not read as weather', () => {
    expect(cloudOffset(60).x).not.toBe(cloudOffset(0).x);
    expect(cloudOffset(60).z).not.toBe(cloudOffset(0).z);
  });

  it('moves the two axes at different rates, so the field does not slide on a diagonal', () => {
    const { x, z } = cloudOffset(1000);
    expect(x).not.toBeCloseTo(z, 3);
  });

  /*
   * The original defect expressed as a test: a caller passing milliseconds
   * lands outside the precision ceiling, so this fails loudly rather than
   * degrading into a flicker nobody traces back to a unit mismatch.
   */
  it('would reject milliseconds being passed as seconds', () => {
    const tenMinutesInMs = 10 * 60 * 1000;
    expect(Math.abs(cloudOffset(tenMinutesInMs).x * 456.21))
      .toBeGreaterThan(PRECISION_CEILING);
  });
});
