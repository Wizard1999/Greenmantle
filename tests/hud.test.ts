import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILDING_TYPES } from '../src/data/buildings';
import { MAX_QUEUE } from '../src/data/tuning';
import { UNIT_TYPES } from '../src/data/units';
import { canPlaceBuilding } from '../src/sim/construction';
import { canTrain } from '../src/sim/production';
import { RESOURCE_LABEL, playerWording, refusal } from '../src/ui/hud';
import { buildSpotNearBase, freshMap, must } from './helpers';

/**
 * `createHud` needs a document and the suite runs in node, so what is tested
 * here is the part that decides what the HUD *says*: the resource vocabulary
 * and the refusal wording. The layout half is measured in a browser by
 * `scripts/measure-hud.mjs`, which is the only place it can honestly be
 * measured at all.
 */

const root = join(import.meta.dirname, '..');
const read = (...parts: string[]): string => readFileSync(join(root, ...parts), 'utf8');

describe('one resource, one name', () => {
  it('calls the gatherable Legacy, the name D-033 settled on', () => {
    expect(RESOURCE_LABEL).toBe('Legacy');
  });

  it('leaves no player-facing "essence" in the surfaces this slice owns', () => {
    // The resources bar said "essence" while the tutorial and research panel
    // said "Legacy" — two words for one number, on the two panels a player
    // looks at most.
    //
    // Only *text* is checked. Identifiers are not player-facing and D-030's
    // precedent keeps them on the format's history rather than the branding:
    // `debugReadout.ts` owns an `essencePerMinute` metric key, is developer
    // scaffolding, and is nobody's vocabulary problem.
    const comments = /\/\*[\s\S]*?\*\/|^[ \t]*\/\/.*$|<!--[\s\S]*?-->/gm;
    const literals = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g;

    const html = read('index.html').replace(comments, '');
    expect(html, 'index.html').not.toMatch(/essence/i);

    for (const file of ['src/ui/hud.ts', 'src/ui/victory.ts', 'src/main.ts']) {
      for (const text of read(file).replace(comments, '').match(literals) ?? []) {
        expect(text, `${file} ${text}`).not.toMatch(/essence/i);
      }
    }
  });

  it('translates the refusals the simulation still words the old way', () => {
    // `sim/production.ts` and `sim/construction.ts` return "not enough essence"
    // and are outside this slice's ownership. Asserting against the live call
    // rather than against their source means this keeps passing when they are
    // corrected, and starts failing if a *new* old-vocabulary reason appears.
    const world = freshMap();
    world.resources.player = 0;
    const standard = must(
      world.buildings.find(b => b.team === 'player' && b.type === 'standard'), 'standard');

    const train = canTrain(world, standard.id, 'legionnaire');
    expect(train.ok).toBe(false);
    expect(must(refusal(train), 'refusal')).toBe(`not enough ${RESOURCE_LABEL}`);

    const spot = buildSpotNearBase(world);
    const place = canPlaceBuilding(world, 'player', 'outpost', spot.x, spot.z);
    expect(place.ok).toBe(false);
    expect(must(refusal(place), 'refusal')).not.toMatch(/essence/i);
  });

  it('rewrites only the word, so a corrected source is not renamed twice', () => {
    expect(playerWording('not enough essence')).toBe('not enough Legacy');
    expect(playerWording('not enough Legacy')).toBe('not enough Legacy');
    expect(playerWording('blocked by Essence')).toBe('blocked by Legacy');
    // Not a substring match: nothing else in the vocabulary contains the word.
    expect(playerWording('queue full')).toBe('queue full');
  });
});

describe('a refusal says why', () => {
  it('reports nothing when the command is available', () => {
    const world = freshMap();
    world.resources.player = 10_000;
    const standard = must(
      world.buildings.find(b => b.team === 'player' && b.type === 'standard'), 'standard');
    expect(refusal(canTrain(world, standard.id, 'worker'))).toBeNull();
  });

  it('gives every refusal canTrain can produce a sentence to show', () => {
    // The defect: the card read only `.ok` and greyed the button, so a player
    // with no Legacy saw three dead controls and no statement of what was
    // missing. Every branch of `canTrain` has to arrive with words.
    const world = freshMap();
    const standard = must(
      world.buildings.find(b => b.team === 'player' && b.type === 'standard'), 'standard');

    world.resources.player = 0;
    const broke = must(refusal(canTrain(world, standard.id, 'legionnaire')), 'no resources');
    expect(broke).toMatch(/Legacy/);

    // Afford it, then fill the queue so a different gate is the one that fires.
    world.resources.player = 10_000;
    for (let i = 0; i < MAX_QUEUE; i++) {
      standard.queue.push({
        type: 'legionnaire', ticksLeft: UNIT_TYPES.legionnaire.buildTicks,
      });
    }
    expect(must(refusal(canTrain(world, standard.id, 'legionnaire')), 'gated'))
      .toBe('queue full');

    // A refusal that arrives with no reason at all still says something.
    expect(refusal({ ok: false })).toBe('unavailable');
  });

  it('states a fact, never a recommendation', () => {
    const ADVICE =
      /\b(recommend\w*|should|advise\w*|suggest\w*|consider|better|best|optimal|try)\b/i;
    const world = freshMap();
    world.resources.player = 0;
    const standard = must(
      world.buildings.find(b => b.team === 'player' && b.type === 'standard'), 'standard');
    for (const unit of BUILDING_TYPES[standard.type].produces) {
      const why = refusal(canTrain(world, standard.id, unit));
      expect(why, unit).not.toBeNull();
      expect(why ?? '', unit).not.toMatch(ADVICE);
    }
  });
});

describe('the end of the match is not a flash message', () => {
  it('no longer announces the winner through the transient channel', () => {
    // It used to `flash()` the result — the same 1.6-second line that carries
    // "orders stopped" — so the result of a match shared a channel with an
    // acknowledgement of a keypress. `ui/victory.ts` owns it now.
    const hud = read('src/ui/hud.ts').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(hud).not.toMatch(/world\.winner/);
    expect(hud).not.toMatch(/VICTORY|DEFEAT/);
  });

  it('builds the outcome surface in the running game', () => {
    const main = read('src/main.ts');
    expect(main).toMatch(/createVictoryOverlay\(/);
    expect(main).toMatch(/victory\.update\(\)/);
  });
});

describe('the resources bar', () => {
  it('names the element after the resource it holds', () => {
    const html = read('index.html');
    expect(html).toMatch(/id="r-legacy"/);
    expect(html).not.toMatch(/id="r-essence"/);
    expect(read('src/ui/hud.ts')).toMatch(/'r-legacy'/);
  });

  it('is still read-only, so the battlefield keeps the click', () => {
    // D-032's rule 1 inverted the pointer-events default and listed the four
    // read-only surfaces that opt out. `#res` is one of them.
    expect(read('index.html')).toMatch(/#res,\s*#flash,\s*#build-id,\s*#selbox\s*\{\s*pointer-events:\s*none/);
  });
});
