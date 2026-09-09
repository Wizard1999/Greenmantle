import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { World } from '../src/core/types';
import { TICK_HZ } from '../src/core/loop';
import { enableAi } from '../src/sim/ai';
import { buildTestMap } from '../src/sim/map';
import { createWorld, simStep } from '../src/sim/world';
import { TEAM_NAME, formatDuration, matchOutcome } from '../src/ui/victory';
import { freshMap, must } from './helpers';

/**
 * Tested through the model, like `missionPanel.test.ts` and for the same
 * reason: the suite runs in node with no DOM, and everything worth asserting
 * about an outcome surface is what it *says*.
 *
 * The one thing a model test cannot cover is whether the panel is ever reached,
 * so the last block plays the match `main.ts` actually sets up and checks that
 * it produces a winner. A victory screen behind a match that never ends is a
 * feature nobody can demo.
 */

/** Wipes a team the way the game does — no structures, no build sites — and
 *  runs past `VICTORY.graceTicks` so `stepVictory` fires. */
const eliminate = (world: World, team: 'player' | 'rival'): void => {
  world.buildings = world.buildings.filter(b => b.team !== team);
  world.sites = world.sites.filter(s => s.team !== team);
  for (let i = 0; i < 40 && !world.winner; i++) simStep(world);
};

describe('match length', () => {
  it('reads in real minutes and seconds, not ticks and not in-game hours', () => {
    // Ten real minutes is a full in-game day (D-013), so an outcome reported on
    // the in-game clock would call a four-minute match half a day.
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(TICK_HZ)).toBe('0:01');
    expect(formatDuration(TICK_HZ * 60)).toBe('1:00');
    expect(formatDuration(TICK_HZ * 158)).toBe('2:38');
  });

  it('pads the seconds so the number does not change width as it counts', () => {
    expect(formatDuration(TICK_HZ * 65)).toBe('1:05');
  });
});

describe('the outcome', () => {
  it('reports nothing while the match is still being played', () => {
    const world = freshMap();
    expect(world.winner).toBeNull();
    expect(matchOutcome(world, 'player', world.tick)).toBeNull();
  });

  it('names the result from the viewing side', () => {
    const won = freshMap();
    eliminate(won, 'rival');
    expect(must(matchOutcome(won, 'player', won.tick), 'outcome').headline).toBe('Victory');

    const lost = freshMap();
    eliminate(lost, 'player');
    expect(must(matchOutcome(lost, 'player', lost.tick), 'outcome').headline).toBe('Defeat');
  });

  it('states the win condition as the event that happened', () => {
    const lost = freshMap();
    eliminate(lost, 'player');
    const defeat = must(matchOutcome(lost, 'player', lost.tick), 'outcome');
    expect(defeat.cause).toBe('Every structure you held was destroyed.');

    const won = freshMap();
    eliminate(won, 'rival');
    const victory = must(matchOutcome(won, 'player', won.tick), 'outcome');
    expect(victory.cause).toBe('Every structure the rival held was destroyed.');
  });

  it('answers who won, why, and how long it took', () => {
    const world = freshMap();
    eliminate(world, 'rival');
    const outcome = must(matchOutcome(world, 'player', world.tick), 'outcome');
    expect(outcome.winner).toBe('player');
    expect(outcome.cause.length).toBeGreaterThan(0);
    expect(outcome.duration).toBe(formatDuration(world.tick));
    expect(outcome.durationTicks).toBe(world.tick);
  });

  it('carries the facts a match is judged on, both sides of each', () => {
    const world = freshMap();
    world.resources.player = 1250;
    world.resources.rival = 40;
    eliminate(world, 'rival');
    const outcome = must(matchOutcome(world, 'player', world.tick), 'outcome');
    const facts = new Map(outcome.facts.map(f => [f.label, f.value]));

    expect([...facts.keys()]).toEqual([
      'Match length', 'Ended', 'Structures standing', 'Units standing',
      'Legacy held', 'Legacy left on the map',
    ]);
    expect(facts.get('Legacy held')).toBe('You 1,250 · Rival 40');
    // The rival was wiped; the readout has to agree with the rule that ended it.
    expect(facts.get('Structures standing')).toMatch(/· Rival 0$/);
    expect(facts.get('Match length')).toBe(outcome.duration);
  });

  it('counts a half-built site as a structure, the way stepVictory does', () => {
    // A team holding only an unfinished outpost has not lost. A readout that
    // said "structures 0" beside a team that is still alive would contradict
    // the rule it exists to report.
    const world = freshMap();
    world.buildings = world.buildings.filter(b => b.team !== 'rival');
    world.sites.push({
      id: world.nextId++, type: 'outpost', team: 'rival',
      x: 0, z: 0, radius: 2, progress: 1, required: 150,
    });
    for (let i = 0; i < 40; i++) simStep(world);
    expect(world.winner).toBeNull();

    world.buildings = world.buildings.filter(b => b.team !== 'player');
    world.sites = world.sites.filter(s => s.team !== 'player');
    for (let i = 0; i < 40 && !world.winner; i++) simStep(world);
    const outcome = must(matchOutcome(world, 'player', world.tick), 'outcome');
    expect(outcome.headline).toBe('Defeat');
    expect(new Map(outcome.facts.map(f => [f.label, f.value])).get('Structures standing'))
      .toBe('You 0 · Rival 1');
  });

  it('names the teams the same way everywhere it names them', () => {
    const world = freshMap();
    eliminate(world, 'rival');
    const outcome = must(matchOutcome(world, 'player', world.tick), 'outcome');
    const paired = ['Structures standing', 'Units standing', 'Legacy held'];
    for (const label of paired) {
      const value = must(outcome.facts.find(f => f.label === label), label).value;
      expect(value, label).toContain(TEAM_NAME.player);
      expect(value, label).toContain(TEAM_NAME.rival);
    }
  });
});

describe('information, never advice', () => {
  /** The same list `missionPanel.test.ts` guards. A defeat screen is where an
   *  interface is most tempted to start coaching, so it is worth guarding
   *  twice. */
  const ADVICE =
    /\b(recommend\w*|should|advise\w*|suggest\w*|consider|better|best|optimal|chance|likely|risky?|instead|try)\b/i;

  it('states no advice anywhere in a rendered outcome', () => {
    for (const loser of ['player', 'rival'] as const) {
      const world = freshMap();
      eliminate(world, loser);
      const outcome = must(matchOutcome(world, 'player', world.tick), 'outcome');
      expect(JSON.stringify(outcome), loser).not.toMatch(ADVICE);
    }
  });

  it('calls the gatherable Legacy and nothing else', () => {
    const world = freshMap();
    eliminate(world, 'rival');
    const outcome = must(matchOutcome(world, 'player', world.tick), 'outcome');
    expect(JSON.stringify(outcome)).not.toMatch(/essence/i);
    expect(JSON.stringify(outcome)).toMatch(/Legacy/);
  });

  it('is styled in the console\'s own material rather than a second language', () => {
    // D-032 unified the panels deliberately. The outcome is the most-looked-at
    // surface in the build, so it is the one most worth checking has not
    // invented its own look.
    const html = readFileSync(join(import.meta.dirname, '..', 'index.html'), 'utf8');
    expect(html).toMatch(/#outcome\s*\{/);
    expect(html).toMatch(/--z-outcome:/);
    // Above the controls sheet: the match can end while the player is reading it.
    const z = (name: string): number =>
      Number(must(new RegExp(`--z-${name}:\\s*(\\d+)`).exec(html), name)[1]);
    expect(z('outcome')).toBeGreaterThan(z('sheet'));
    expect(z('outcome')).toBeLessThan(z('dev'));
  });
});

describe('the surface is actually reached', () => {
  it('the match main.ts sets up ends, and ends within a demo', () => {
    // Measured rather than assumed: seed 1337 with the standard AI and no
    // player input. If this ever stops ending, the outcome panel silently
    // becomes unreachable and nothing else in the suite would notice.
    const world = enableAi(buildTestMap(createWorld(1337, 8, 1337)));
    const limit = TICK_HZ * 60 * 10;
    let ticks = 0;
    while (!world.winner && ticks < limit) { simStep(world); ticks++; }

    expect(world.winner, 'no winner within ten minutes').not.toBeNull();
    const outcome = must(matchOutcome(world, 'player', world.tick), 'outcome');
    // Which side wins is a balance question and belongs to whoever owns
    // `data/tuning.ts`. That it ends at all is what this guards.
    expect(['Victory', 'Defeat']).toContain(outcome.headline);
    expect(outcome.durationTicks).toBeLessThan(limit);
    expect(outcome.duration).toMatch(/^\d+:\d\d$/);
  });
});
