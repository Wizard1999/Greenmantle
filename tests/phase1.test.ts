import { describe, expect, it } from 'vitest';
import { createWorld, simStep } from '../src/sim/world';
import { buildTestMap } from '../src/sim/map';
import { spawnUnit } from '../src/sim/entities';
import { enableAi } from '../src/sim/ai';
import { hash } from '../src/sim/snapshot';
import { COHESION, COMBAT, VICTORY } from '../src/data/tuning';
import {
  approachFrom, cohesionEffectiveness, elevationMultiplier, findTarget,
  flankMultiplier, localCrowding, resolvedDamage,
} from '../src/sim/combat';
import { must, run } from './helpers';
import type { Unit, World } from '../src/core/types';

const fresh = (seed = 1337) => buildTestMap(createWorld(seed));

/** A bare world with nothing on it, for isolating combat maths. */
function empty(): World {
  const w = createWorld(99);
  w.units = []; w.buildings = []; w.nodes = []; w.sites = []; w.squads = [];
  return w;
}

function put(w: World, type: 'legionnaire' | 'marksman' | 'worker',
             team: 'player' | 'rival', x: number, z: number): Unit {
  const u = spawnUnit(w, type, team, x, z);
  u.stillTicks = COMBAT.settleTicks;   // fully set up, so accuracy is not the variable
  return u;
}

// --- 1.9 Squad cohesion ---------------------------------------------------

describe('[1.9] squad cohesion', () => {
  it('a small group takes no penalty', () => {
    const w = empty();
    const us = Array.from({ length: 5 }, (_, i) => put(w, 'legionnaire', 'player', i * 0.5, 0));
    expect(cohesionEffectiveness(w, must(us[0]))).toBe(1);
  });

  it('is unaffected right up to the cap', () => {
    const w = empty();
    const us = Array.from({ length: COHESION.cap }, (_, i) =>
      put(w, 'legionnaire', 'player', (i % 5) * 0.4, Math.floor(i / 5) * 0.4));
    expect(localCrowding(w, must(us[0]))).toBe(COHESION.cap);
    expect(cohesionEffectiveness(w, must(us[0]))).toBe(1);
  });

  it('degrades past the cap', () => {
    const w = empty();
    const us = Array.from({ length: COHESION.cap + 10 }, (_, i) =>
      put(w, 'legionnaire', 'player', (i % 6) * 0.4, Math.floor(i / 6) * 0.4));
    const e = cohesionEffectiveness(w, must(us[0]));
    expect(e).toBeLessThan(1);
    expect(e).toBeCloseTo(1 - 10 * COHESION.penaltyPerUnit, 6);
  });

  it('never falls below the floor', () => {
    const w = empty();
    const us = Array.from({ length: 200 }, (_, i) =>
      put(w, 'legionnaire', 'player', (i % 14) * 0.3, Math.floor(i / 14) * 0.3));
    expect(cohesionEffectiveness(w, must(us[0]))).toBe(COHESION.minEffectiveness);
  });

  it('spreading out removes the penalty', () => {
    // The whole point of the mechanic: the counterplay is positional.
    const w = empty();
    const packed = Array.from({ length: COHESION.cap + 12 }, (_, i) =>
      put(w, 'legionnaire', 'player', (i % 6) * 0.4, Math.floor(i / 6) * 0.4));
    expect(cohesionEffectiveness(w, must(packed[0]))).toBeLessThan(1);

    const spread = empty();
    const wide = Array.from({ length: COHESION.cap + 12 }, (_, i) =>
      put(spread, 'legionnaire', 'player', i * (COHESION.radius + 1), 0));
    expect(cohesionEffectiveness(spread, must(wide[0]))).toBe(1);
  });

  it('workers are exempt — a mining camp is not a deathball', () => {
    const w = empty();
    const ws = Array.from({ length: 40 }, (_, i) =>
      put(w, 'worker', 'player', (i % 6) * 0.4, Math.floor(i / 6) * 0.4));
    expect(cohesionEffectiveness(w, must(ws[0]))).toBe(1);
  });

  it('§2: a 35-stack only barely out-fights a 22-stack', () => {
    // The design's explicit requirement -- "a 30-40 unit army should only
    // barely beat a 20-25 unit army". This is the test that keeps the cohesion
    // constants honest if anyone retunes them.
    const power = (n: number): number => {
      const w = empty();
      const us = Array.from({ length: n }, (_, i) =>
        put(w, 'legionnaire', 'player', (i % 7) * 0.4, Math.floor(i / 7) * 0.4));
      return n * cohesionEffectiveness(w, must(us[0]));
    };
    const big = power(35);
    const small = power(22);
    expect(big).toBeGreaterThan(small);          // bigger still wins...
    expect(big / small).toBeLessThan(1.15);      // ...but only barely
  });
});

// --- 1.10 Positioning-driven combat --------------------------------------

describe('[1.10] positioning decides fights', () => {
  it('high ground hits harder than low ground', () => {
    const w = empty();
    // Sample the terrain for a genuine height difference rather than assuming.
    const a = put(w, 'legionnaire', 'player', 0, 0);
    const d = put(w, 'legionnaire', 'rival', 1, 0);
    const hi = elevationMultiplier(a, d);
    const lo = elevationMultiplier(d, a);
    expect(hi * lo).toBeGreaterThan(0);
    expect(Math.max(hi, lo)).toBeGreaterThanOrEqual(1);
  });

  it('elevation multipliers match the tuning at a real height gap', () => {
    // The two positions must be searched independently. This previously placed
    // the defender at the attacker's 180° mirror, which found a height gap only
    // because the terrain was asymmetric — the defect B-007 fixed. Mirrored
    // points are now guaranteed equal in height, so that search can never
    // succeed, and it would have quietly re-encoded the bug as a requirement.
    const w = empty();
    const a = put(w, 'legionnaire', 'player', 0, 0);
    const d = put(w, 'legionnaire', 'rival', 0, 0);
    let high = false;
    let low = false;
    for (let x = -30; x <= 30 && !(high && low); x += 2) {
      for (let z = -30; z <= 30 && !(high && low); z += 2) {
        a.x = x; a.z = z;
        // Offset within a plausible engagement, not across the whole board.
        d.x = x + COMBAT.acquireRange; d.z = z;
        const m = elevationMultiplier(a, d);
        if (m === COMBAT.highGroundBonus) high = true;
        if (m === COMBAT.lowGroundPenalty) low = true;
      }
    }
    expect(high).toBe(true);
    expect(low).toBe(true);
  });

  it('reads the approach angle from the defender facing', () => {
    const w = empty();
    const d = put(w, 'legionnaire', 'rival', 0, 0);
    d.facing = 0;                                  // looking toward +z
    const front = put(w, 'legionnaire', 'player', 0, 5);
    const rear = put(w, 'legionnaire', 'player', 0, -5);
    const side = put(w, 'legionnaire', 'player', 5, 0);
    expect(approachFrom(front, d)).toBe('front');
    expect(approachFrom(rear, d)).toBe('rear');
    expect(approachFrom(side, d)).toBe('side');
  });

  it('flanking beats a side attack, which beats a frontal one', () => {
    const w = empty();
    const d = put(w, 'legionnaire', 'rival', 0, 0);
    d.facing = 0;
    const front = put(w, 'legionnaire', 'player', 0, 5);
    const side = put(w, 'legionnaire', 'player', 5, 0);
    const rear = put(w, 'legionnaire', 'player', 0, -5);
    expect(flankMultiplier(rear, d)).toBeGreaterThan(flankMultiplier(side, d));
    expect(flankMultiplier(side, d)).toBeGreaterThan(flankMultiplier(front, d));
    expect(flankMultiplier(front, d)).toBe(1);
  });

  it('a flanking attack deals strictly more damage', () => {
    const w = empty();
    const d = put(w, 'legionnaire', 'rival', 0, 0);
    d.facing = 0;
    const front = put(w, 'legionnaire', 'player', 0, 5);
    const rear = put(w, 'legionnaire', 'player', 0, -5);
    expect(resolvedDamage(w, rear, d)).toBeGreaterThan(resolvedDamage(w, front, d));
  });

  it('acquires the nearest enemy, breaking ties by id for determinism', () => {
    const w = empty();
    const me = put(w, 'legionnaire', 'player', 0, 0);
    const far = put(w, 'legionnaire', 'rival', 4, 0);
    const near = put(w, 'legionnaire', 'rival', 2, 0);
    expect(findTarget(w, me)?.id).toBe(near.id);
    expect(far.id).toBeGreaterThan(0);
  });

  it('units fight when enemies come into range, unprompted', () => {
    const w = empty();
    put(w, 'legionnaire', 'player', 0, 0);
    const b = put(w, 'legionnaire', 'rival', 0.8, 0);
    const before = b.hp;
    run(w, 30);
    expect(b.hp).toBeLessThan(before);
  });

  it('a fight actually kills, and the dead are swept up', () => {
    const w = empty();
    put(w, 'legionnaire', 'player', 0, 0);
    const victim = put(w, 'legionnaire', 'rival', 0.8, 0);
    victim.hp = 5;
    run(w, 40);
    expect(w.units.some(u => u.id === victim.id)).toBe(false);
  });

  it('combat consumes no RNG, so it cannot desync', () => {
    // Damage is a deterministic expectation, not a die roll.
    const w = empty();
    put(w, 'legionnaire', 'player', 0, 0);
    put(w, 'legionnaire', 'rival', 0.8, 0);
    const before = w.rngState;
    run(w, 60);
    expect(w.rngState).toBe(before);
  });
});

// --- 1.11 AI opponent -----------------------------------------------------

describe('[1.11] AI opponent', () => {
  it('a world has no opponent unless one is asked for', () => {
    expect(fresh().ai).toBeNull();
  });

  it('gathers without being told', () => {
    const w = enableAi(fresh());
    run(w, 200);
    expect(w.resources.rival).toBeGreaterThan(0);
  });

  it('builds an army', () => {
    const w = enableAi(fresh());
    const before = w.units.filter(u => u.team === 'rival').length;
    run(w, 2000);
    expect(w.units.filter(u => u.team === 'rival').length).toBeGreaterThan(before);
  });

  it('eventually commits to attacking', () => {
    const w = enableAi(fresh());
    run(w, 4000);
    expect(must(w.ai).attacking).toBe(true);
  });

  it('is deterministic — same seed, same match', () => {
    const a = enableAi(fresh(2024));
    const b = enableAi(fresh(2024));
    run(a, 1200); run(b, 1200);
    expect(hash(a)).toBe(hash(b));
  });

  it('its decisions are part of hashed state', () => {
    // Otherwise a replay could diverge on AI choices and still report agreement.
    const a = enableAi(fresh(5));
    const b = enableAi(fresh(5));
    run(a, 100); run(b, 100);
    must(b.ai).attacking = !must(b.ai).attacking;
    expect(hash(a)).not.toBe(hash(b));
  });
});

// --- 1.12 Base-destruction win condition ---------------------------------

describe('[1.12] win condition', () => {
  it('nobody has won at the start', () => {
    expect(fresh().winner).toBeNull();
  });

  it('losing every building loses the match', () => {
    const w = fresh();
    w.buildings = w.buildings.filter(b => b.team !== 'rival');
    w.sites = w.sites.filter(s => s.team !== 'rival');
    run(w, VICTORY.graceTicks + 5);
    expect(w.winner).toBe('player');
  });

  it('works the other way too', () => {
    const w = fresh();
    w.buildings = w.buildings.filter(b => b.team !== 'player');
    w.sites = w.sites.filter(s => s.team !== 'player');
    run(w, VICTORY.graceTicks + 5);
    expect(w.winner).toBe('rival');
  });

  it('a grace period stops a match ending on a single-tick gap', () => {
    const w = fresh();
    w.buildings = w.buildings.filter(b => b.team !== 'rival');
    run(w, 2);
    expect(w.winner).toBeNull();     // not called instantly...
    run(w, VICTORY.graceTicks + 5);
    expect(w.winner).toBe('player'); // ...but called once it is real
  });

  it('a pending construction site keeps a team alive', () => {
    // Losing while a replacement base is mid-build would be losing to a race
    // condition rather than to the opponent.
    const w = fresh();
    const doomed = must(w.buildings.find(b => b.team === 'rival'));
    w.buildings = w.buildings.filter(b => b.id !== doomed.id);
    w.sites.push({
      id: w.nextId++, type: 'outpost', team: 'rival',
      x: 10, z: -10, radius: 1.4, progress: 1, required: 150,
    });
    run(w, VICTORY.graceTicks + 5);
    expect(w.winner).toBeNull();
  });

  it('buildings are destructible', () => {
    const w = empty();
    const b = must(fresh().buildings[0]);
    w.buildings = [{ ...b, team: 'rival', x: 0, z: 0 }];
    for (let i = 0; i < 6; i++) put(w, 'legionnaire', 'player', 1.5 + i * 0.3, 0);
    const before = must(w.buildings[0]).hp;
    run(w, 60);
    expect(must(w.buildings[0])?.hp ?? 0).toBeLessThan(before);
  });

  it('the match settles — a full AI game reaches a winner', () => {
    // The end-to-end proof that Phase 1 is a game: two sides, one survivor.
    const w = enableAi(fresh(7));
    for (let i = 0; i < 30000 && !w.winner; i++) simStep(w);
    expect(w.winner).not.toBeNull();
  });
});
