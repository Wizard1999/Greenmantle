import { describe, expect, it } from 'vitest';
import { createWorld } from '../src/sim/world';
import { buildTestMap } from '../src/sim/map';
import { spawnUnit } from '../src/sim/entities';
import { hash } from '../src/sim/snapshot';
import { TECH } from '../src/data/tech';
import type { TechId } from '../src/data/tech';
import {
  availableTech, canResearch, cmdCancelResearch, cmdResearch, hasTech,
  modifiersFor, modifiersForUnit,
} from '../src/sim/tech';
import { approachFrom, effectiveDefense, maxHp, resolvedDamage } from '../src/sim/combat';
import { COMBAT } from '../src/data/tuning';
import { cmdGather } from '../src/sim/commands';
import { must, run } from './helpers';
import type { Unit, World } from '../src/core/types';

const fresh = (seed = 1337) => buildTestMap(createWorld(seed));

/**
 * Research `id` by granting funds and running the clock out.
 *
 * Not instant, and the difference matters: this steps the world several hundred
 * ticks, during which anything already on the board fights, moves, turns and
 * dies. A scenario that wants a controlled measurement must be spawned *after*
 * this returns, or it will be measured mid-engagement — see the duel below.
 */
function grant(w: World, id: TechId): void {
  w.resources.player = 100_000;
  expect(cmdResearch(w, 'player', id).ok).toBe(true);
  run(w, TECH[id].researchTicks + 1);
  expect(hasTech(w, 'player', id)).toBe(true);
}

describe('research mechanics', () => {
  it('starts with nothing researched', () => {
    const w = fresh();
    expect(w.tech.player.researched).toEqual([]);
    expect(w.tech.player.researching).toBeNull();
  });

  it('completes after its research time and not before', () => {
    const w = fresh();
    w.resources.player = 100_000;
    cmdResearch(w, 'player', 'quarryDiscipline');
    run(w, TECH.quarryDiscipline.researchTicks - 1);
    expect(hasTech(w, 'player', 'quarryDiscipline')).toBe(false);
    run(w, 2);
    expect(hasTech(w, 'player', 'quarryDiscipline')).toBe(true);
  });

  it('costs resources up front', () => {
    const w = fresh();
    w.resources.player = 1000;
    cmdResearch(w, 'player', 'quarryDiscipline');
    expect(w.resources.player).toBe(1000 - TECH.quarryDiscipline.cost);
  });

  it('refuses when it cannot be afforded', () => {
    const w = fresh();
    w.resources.player = 0;
    expect(cmdResearch(w, 'player', 'quarryDiscipline').ok).toBe(false);
  });

  it('enforces prerequisites', () => {
    const w = fresh();
    w.resources.player = 100_000;
    expect(canResearch(w, 'player', 'deepSeams').ok).toBe(false);
    grant(w, 'quarryDiscipline');
    expect(canResearch(w, 'player', 'deepSeams').ok).toBe(true);
  });

  it('only one thing at a time', () => {
    const w = fresh();
    w.resources.player = 100_000;
    expect(cmdResearch(w, 'player', 'quarryDiscipline').ok).toBe(true);
    expect(cmdResearch(w, 'player', 'reinforcedPlate').ok).toBe(false);
  });

  it('cancelling refunds in full', () => {
    const w = fresh();
    w.resources.player = 1000;
    cmdResearch(w, 'player', 'reinforcedPlate');
    run(w, 30);
    expect(cmdCancelResearch(w, 'player').ok).toBe(true);
    expect(w.resources.player).toBe(1000);
    expect(w.tech.player.researching).toBeNull();
  });

  it('research is per team', () => {
    const w = fresh();
    grant(w, 'reinforcedPlate');
    expect(hasTech(w, 'player', 'reinforcedPlate')).toBe(true);
    expect(hasTech(w, 'rival', 'reinforcedPlate')).toBe(false);
  });
});

describe('§8.5 Cohort is linear and forgiving', () => {
  it('doctrine pairs do not lock each other out', () => {
    // The distinguishing property of Cohort's track. Conclave's branches
    // foreclose; Cohort's only change what you have first.
    const w = fresh();
    grant(w, 'reinforcedPlate');
    grant(w, 'attritionDoctrine');
    expect(canResearch(w, 'player', 'vanguardDoctrine').ok).toBe(true);
    grant(w, 'vanguardDoctrine');
    expect(hasTech(w, 'player', 'attritionDoctrine')).toBe(true);
    expect(hasTech(w, 'player', 'vanguardDoctrine')).toBe(true);
  });

  it('researching everything in order works', () => {
    const w = fresh();
    for (const id of ['quarryDiscipline', 'deepSeams', 'reinforcedPlate',
      'measuredVolley', 'attritionDoctrine', 'vanguardDoctrine', 'enduringFrames'] as const) {
      grant(w, id);
    }
    expect(w.tech.player.researched).toHaveLength(7);
  });

  it('availableTech offers only what is currently reachable', () => {
    const w = fresh();
    expect(availableTech(w, 'player')).not.toContain('deepSeams');
    grant(w, 'quarryDiscipline');
    expect(availableTech(w, 'player')).toContain('deepSeams');
    expect(availableTech(w, 'player')).not.toContain('quarryDiscipline');
  });
});

describe('upgrades apply to categories, not single units', () => {
  it('a melee upgrade raises Legionnaire defense but not Marksman', () => {
    const w = fresh();
    const leg = spawnUnit(w, 'legionnaire', 'player', 40, 40);
    const mark = spawnUnit(w, 'marksman', 'player', 44, 40);
    const legBefore = effectiveDefense(w, leg);
    const markBefore = effectiveDefense(w, mark);

    grant(w, 'reinforcedPlate');
    expect(effectiveDefense(w, leg)).toBeGreaterThan(legBefore);
    expect(effectiveDefense(w, mark)).toBe(markBefore);
  });

  it('a ranged upgrade raises Marksman damage but not Legionnaire', () => {
    const w = fresh();
    const legMod = () => modifiersForUnit(w, 'player', 'legionnaire').damageMul;
    const markMod = () => modifiersForUnit(w, 'player', 'marksman').damageMul;
    const legBefore = legMod();
    grant(w, 'measuredVolley');
    expect(markMod()).toBeGreaterThan(1);
    expect(legMod()).toBe(legBefore);
  });

  it("an 'all' doctrine lifts every category at once", () => {
    const w = fresh();
    grant(w, 'reinforcedPlate');
    grant(w, 'vanguardDoctrine');
    expect(modifiersFor(w, 'player', 'melee').damageMul).toBeGreaterThan(1);
    expect(modifiersFor(w, 'player', 'ranged').damageMul).toBeGreaterThan(1);
    expect(modifiersFor(w, 'player', 'worker').damageMul).toBeGreaterThan(1);
  });

  it('same-category upgrades compound', () => {
    const w = fresh();
    grant(w, 'quarryDiscipline');
    const one = modifiersFor(w, 'player', 'worker').carryMul;
    grant(w, 'deepSeams');
    expect(modifiersFor(w, 'player', 'worker').carryMul).toBeGreaterThan(one);
  });
});

describe('research changes real outcomes', () => {
  /**
   * A marksman shooting a legionnaire, parked at (40, 40).
   *
   * Deliberately far from both spawns — the nearest map unit is about 13 away,
   * outside `acquireRange` — so the only thing that can hurt the defender for
   * the length of the window is the marksman under test.
   */
  const duel = (w: World): { atk: Unit; def: Unit } => ({
    atk: spawnUnit(w, 'marksman', 'player', 40, 40),
    def: spawnUnit(w, 'legionnaire', 'rival', 42, 40),
  });

  /** Long enough for several volleys from both sides, short enough that both
   *  duellists are still standing when the tape is read. */
  const DUEL_TICKS = 150;

  it('raises damage actually dealt', () => {
    // Measured as hp removed by a team holding Measured Volley against hp
    // removed by a team that does not, over the same window on two otherwise
    // identical worlds.
    //
    // It used to be one `resolvedDamage` reading taken before the research and
    // another taken after, in a single world, which compared two different
    // engagements and called the difference research. Waiting out the upgrade
    // means running 450 ticks of live combat, and `resolvedDamage` folds in the
    // defender's facing: measured, the legionnaire was exposed side-on at spawn
    // (x1.15) and had come about to face its attacker by the second reading
    // (x1.00), which cancels Measured Volley's x1.15 to the last decimal —
    // 13.7655 both times. The marksman was also dead and swept up by the reaper
    // some forty ticks before that reading was taken. Neither fault was visible
    // while facing was written only by movement, because a unit that stopped
    // moving stopped turning and the number happened to land favourably.
    //
    // Both worlds are stepped through the research clock *before* either duel
    // is spawned, so the pair meets at the same tick on both boards and turns
    // through the same angles. Nothing comes about in one world and not the
    // other.
    const armed = fresh();
    const plain = fresh();
    grant(armed, 'measuredVolley');
    run(plain, TECH.measuredVolley.researchTicks + 1);

    const a = duel(armed);
    const p = duel(plain);
    run(armed, DUEL_TICKS);
    run(plain, DUEL_TICKS);

    // Reading damage off a corpse is exactly how this test used to lie.
    expect(armed.units).toContain(a.atk);
    expect(plain.units).toContain(p.atk);

    // Facing is a damage multiplier, so the two duels are only comparable while
    // the defenders stand in the same place looking the same way. Asserting it
    // is what makes the measurement below about research rather than about
    // geometry — if the two boards ever diverge, this fails loudly instead of
    // quietly moving the number.
    expect(a.def.x).toBe(p.def.x);
    expect(a.def.z).toBe(p.def.z);
    expect(a.def.facing).toBe(p.def.facing);
    expect(approachFrom(a.atk, a.def)).toBe(approachFrom(p.atk, p.def));

    const dealtArmed = maxHp(armed, a.def) - a.def.hp;
    const dealtPlain = maxHp(plain, p.def) - p.def.hp;
    expect(dealtPlain).toBeGreaterThan(0);
    expect(dealtArmed).toBeGreaterThan(dealtPlain);
    // Measured over 150 ticks: 61.23 hp against 53.24. Shot cadence, accuracy
    // ramp and every positional term are shared between the two boards, so the
    // ratio has nowhere to land except on the upgrade's own multiplier — read
    // from the tech table rather than written out, so retuning the upgrade
    // retunes the expectation with it.
    expect(dealtArmed / dealtPlain)
      .toBeCloseTo(modifiersForUnit(armed, 'player', 'marksman').damageMul, 6);
  });

  it('…but buys less than the angle the shot is fired from (§2)', () => {
    // §2 puts initial positioning above mid-fight adjustment, and this is the
    // seam where the tech track has to live with that. It belongs here rather
    // than in the facing suite because the subject is what an upgrade is
    // *worth*, not how a unit turns.
    //
    // Worth stating now and not before: until facing became bounded, a defender
    // reoriented instantly every tick, so the rear arc could not be reached by
    // manoeuvre and this comparison was between one real number and one the
    // player could never obtain. It is now a trade a commander can actually
    // make.
    const plain = fresh();
    const armed = fresh();
    grant(armed, 'measuredVolley');

    // One pair per world, turned in place. Spawning a fresh legionnaire per
    // reading would stack same-type neighbours on one spot and quietly hand the
    // defender a shield wall.
    const shotInto = (w: World): (arc: 'front' | 'side' | 'rear') => number => {
      const { atk, def } = duel(w);
      atk.stillTicks = COMBAT.settleTicks;
      // Arcs derived from where the pair actually stands, so they survive the
      // duel being moved.
      const toAttacker = Math.atan2(atk.x - def.x, atk.z - def.z);
      const facings = {
        front: toAttacker,
        side: toAttacker + Math.PI / 2,
        rear: toAttacker + Math.PI,
      };
      return (arc): number => {
        def.facing = facings[arc];
        expect(approachFrom(atk, def)).toBe(arc);
        return resolvedDamage(w, atk, def);
      };
    };
    const plainShot = shotInto(plain);
    const armedShot = shotInto(armed);

    // Measured against a legionnaire's 0.1 defense with the marksman set up.
    expect(plainShot('front')).toBeCloseTo(11.97, 4);
    expect(plainShot('side')).toBeCloseTo(13.7655, 4);
    expect(plainShot('rear')).toBeCloseTo(16.1595, 4);

    // Measured Volley is x1.15, which is precisely what the side arc gives away
    // for free: an upgraded volley into a defender's face and an un-upgraded
    // one into its flank are the same number to six decimals. The rear arc's
    // x1.35 beats the upgrade outright.
    expect(armedShot('front')).toBeCloseTo(plainShot('side'), 6);
    expect(armedShot('front')).toBeLessThan(plainShot('rear'));
  });

  it('raises max HP', () => {
    const w = fresh();
    const u = spawnUnit(w, 'legionnaire', 'player', 40, 40);
    const before = maxHp(w, u);
    grant(w, 'reinforcedPlate');
    grant(w, 'attritionDoctrine');
    expect(maxHp(w, u)).toBeGreaterThan(before);
  });

  it('raises worker income', () => {
    // Workers on the test map start idle, so they need an explicit gather
    // order before income exists to compare at all.
    const send = (w: World): void => {
      const workers = w.units.filter(u => u.team === 'player' && u.gather).map(u => u.id);
      cmdGather(w, workers, must(w.nodes[0], 'node').id);
    };
    const w = fresh();
    const baseline = fresh();
    grant(w, 'quarryDiscipline');
    send(w); send(baseline);
    w.resources.player = 0;
    baseline.resources.player = 0;
    run(w, 1200);
    run(baseline, 1200);
    expect(baseline.resources.player).toBeGreaterThan(0);
    expect(w.resources.player).toBeGreaterThan(baseline.resources.player);
  });
});

describe('research is deterministic sim state', () => {
  it('is part of the hash', () => {
    const a = fresh(5); const b = fresh(5);
    expect(hash(a)).toBe(hash(b));
    a.resources.player = 100_000; b.resources.player = 100_000;
    cmdResearch(a, 'player', 'reinforcedPlate');
    expect(hash(a)).not.toBe(hash(b));
  });

  it('two worlds researching identically stay in step', () => {
    const a = fresh(5); const b = fresh(5);
    for (const w of [a, b]) { w.resources.player = 100_000; cmdResearch(w, 'player', 'measuredVolley'); }
    run(a, 800); run(b, 800);
    expect(hash(a)).toBe(hash(b));
  });

  it('survives a serialize round trip', () => {
    const w = fresh();
    grant(w, 'reinforcedPlate');
    w.resources.player = 100_000;
    cmdResearch(w, 'player', 'attritionDoctrine');
    const wire = JSON.parse(JSON.stringify(w)) as World;
    expect(hash(wire)).toBe(hash(w));
    run(w, 200); run(wire, 200);
    expect(hash(wire)).toBe(hash(w));
  });

  it('modifiers are derived, so a restore cannot leave stale stats behind', () => {
    // The reason modifiers are recomputed rather than baked into units when a
    // tech completes: rewinding must un-apply them, and nothing would catch it
    // if the stats themselves were the source of truth.
    const w = fresh();
    const u = spawnUnit(w, 'legionnaire', 'player', 40, 40);
    const before = effectiveDefense(w, u);
    grant(w, 'reinforcedPlate');
    expect(effectiveDefense(w, u)).toBeGreaterThan(before);

    w.tech.player.researched = [];
    expect(effectiveDefense(w, u)).toBe(before);
  });
});

describe('engine-first: the tech engine knows nothing about Cohort', () => {
  it('drives entirely off the data table', () => {
    // Swapping in a different race pack must not require touching sim/tech.ts.
    // Guarded by construction: every id the engine acts on comes from TECH.
    for (const id of Object.keys(TECH) as TechId[]) {
      const def = must(TECH[id]);
      expect(def.effects.length).toBeGreaterThan(0);
      expect(def.cost).toBeGreaterThan(0);
      expect(def.researchTicks).toBeGreaterThan(0);
      for (const req of def.requires) expect(TECH[req]).toBeDefined();
    }
  });

  it('categorises units by their stats, not by hardcoded names', () => {
    // A new melee unit joins the melee upgrades automatically.
    const w = fresh();
    grant(w, 'reinforcedPlate');
    expect(modifiersForUnit(w, 'player', 'legionnaire').defenseAdd).toBeGreaterThan(0);
    expect(modifiersForUnit(w, 'player', 'marksman').defenseAdd).toBe(0);
  });

  it('has no dangling prerequisites anywhere in the tree', () => {
    for (const id of Object.keys(TECH) as TechId[]) {
      for (const req of TECH[id].requires) {
        expect(Object.keys(TECH)).toContain(req);
        expect(req).not.toBe(id);
      }
    }
  });
});
