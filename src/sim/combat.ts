import type { Building, EntityId, Team, Unit, World } from '../core/types';
import { UNIT_TYPES } from '../data/units';
import { COHESION, COMBAT, VICTORY } from '../data/tuning';
import { HIGH_GROUND_THRESHOLD, terrainHeightAt } from './terrain';
import { modifiersForUnit } from './tech';

/**
 * Combat: derived stats, cohesion, positional resolution and elimination.
 *
 * The governing idea from §2 is that *where* a unit stands decides fights more
 * than what the player does mid-fight. So every modifier here is positional —
 * high ground, facing, crowding — and none of them reward clicking.
 *
 * Damage is applied as a deterministic expectation rather than a die roll.
 * §2 asks for battles that are "quick and decisive" with micro *not* a major
 * skill factor; rolling to hit adds variance that rewards neither positioning
 * nor skill, only luck, and it would make identical engagements resolve
 * differently. Accuracy is therefore a multiplier, not a coin flip. It also
 * keeps combat off the RNG entirely, which keeps replays and lockstep simpler.
 */

/**
 * Same-type wall-forming allies within shield-wall radius, excluding self.
 *
 * Driven by the `formsShieldWall` trait rather than by unit name: the engine
 * must not know Cohort's roster, so a future race declares the flag and
 * inherits the mechanic without touching this file.
 */
export function adjacentWallmates(world: World, unit: Unit): number {
  if (!UNIT_TYPES[unit.type].formsShieldWall) return 0;
  let n = 0;
  for (const other of world.units) {
    if (other.id === unit.id) continue;
    if (other.type !== unit.type) continue;
    if (other.team !== unit.team) continue;
    if (other.hp <= 0) continue;
    if (Math.hypot(other.x - unit.x, other.z - unit.z) <= COMBAT.shieldWallRadius) n++;
  }
  return n;
}

/** @deprecated Cohort-flavoured alias kept for existing call sites. */
export const adjacentLegionnaires = adjacentWallmates;

/** Adjacent wall-mates that actually count, after the cap. */
export function shieldWallStacks(world: World, unit: Unit): number {
  return Math.min(adjacentWallmates(world, unit), COMBAT.shieldWallMaxNeighbours);
}

/**
 * Defense as a fraction of incoming damage ignored. For a Legionnaire this
 * climbs with the shield wall, so a formed line measurably out-trades the same
 * models standing apart — the mechanic §8.7 gives the unit.
 */
export function effectiveDefense(world: World, unit: Unit): number {
  const base = UNIT_TYPES[unit.type].combat.defense
    + modifiersForUnit(world, unit.team, unit.type).defenseAdd;
  const wall = shieldWallStacks(world, unit) * COMBAT.shieldWallPerNeighbour;
  return Math.min(base + wall, COMBAT.maxDefense);
}

/** A unit is "set up" once it has held position for COMBAT.settleTicks. */
export function settleFraction(unit: Unit): number {
  if (COMBAT.settleTicks <= 0) return 1;
  return Math.min(unit.stillTicks / COMBAT.settleTicks, 1);
}

/**
 * Accuracy right now: interpolated from the moving value to the stationary one
 * as the unit settles. For a Marksman the gap is large and the ramp is the
 * reason kiting is a bad idea; for everything else the two values are equal,
 * so this returns a constant.
 */
export function effectiveAccuracy(unit: Unit): number {
  const c = UNIT_TYPES[unit.type].combat;
  return c.accuracyMoving + (c.accuracyStationary - c.accuracyMoving) * settleFraction(unit);
}

/** Expected damage per attack, before positional modifiers (high ground and
 *  flanking arrive with 1.9). Accuracy is folded in as an expectation rather
 *  than a die roll so the value is comparable and testable. */
export function expectedDamage(world: World, attacker: Unit, defender: Unit): number {
  const raw = UNIT_TYPES[attacker.type].combat.damage;
  return raw * effectiveAccuracy(attacker) * (1 - effectiveDefense(world, defender));
}

export function isAlive(unit: Unit): boolean {
  return unit.hp > 0;
}

/** Max HP after research. Takes the world so tech applies — a unit's ceiling
 *  is a function of what its team has researched, not of the unit alone. */
export function maxHp(world: World, unit: Unit): number {
  return UNIT_TYPES[unit.type].combat.hp * modifiersForUnit(world, unit.team, unit.type).hpMul;
}

/** Tracks how long each unit has held position. Runs after movement so that a
 *  unit which moved this tick is correctly counted as moving. */
export function stepSettle(world: World): void {
  for (const u of world.units) {
    const moved = u.x !== u.prevX || u.z !== u.prevZ;
    if (moved) u.stillTicks = 0;
    else u.stillTicks++;
  }
}


// --- Squad cohesion (1.9, §8.6) -------------------------------------------

/**
 * Friendly combat units packed in around this one, itself included.
 *
 * Counted by proximity rather than by squad membership. The design text is
 * ambiguous between the two (§8.6 names the mechanic after squads; §2 describes
 * it as "20+ units in one place"), but squad-based counting would be trivially
 * dodgeable — an ungrouped blob would take no penalty, and that blob is exactly
 * what the rule exists to discourage. Workers are excluded: a mining camp is
 * not a deathball.
 */
export function localCrowding(world: World, unit: Unit): number {
  let n = 0;
  for (const other of world.units) {
    if (other.hp <= 0) continue;
    if (other.team !== unit.team) continue;
    if (UNIT_TYPES[other.type].isWorker) continue;
    if (Math.hypot(other.x - unit.x, other.z - unit.z) <= COHESION.radius) n++;
  }
  return n;
}

/**
 * Effectiveness multiplier from crowding, 1 down to `minEffectiveness`.
 *
 * Cohort's flavour of this is Command Overload (§8.6) — past the cap a squad
 * needs a second officer-type unit to keep full accuracy. The Chronicler that
 * would relieve it is Phase 1 roster but not yet implemented, so for now the
 * penalty always applies; that unit becomes a mitigation hook later.
 */
export function cohesionEffectiveness(world: World, unit: Unit): number {
  if (UNIT_TYPES[unit.type].isWorker) return 1;
  const excess = localCrowding(world, unit) - COHESION.cap;
  if (excess <= 0) return 1;
  return Math.max(COHESION.minEffectiveness, 1 - excess * COHESION.penaltyPerUnit);
}

// --- Positional modifiers (1.10, §2) --------------------------------------

/** Height advantage of the attacker over the defender, as a multiplier. */
export function elevationMultiplier(attacker: Unit, defender: Unit): number {
  const d = terrainHeightAt(attacker.x, attacker.z) - terrainHeightAt(defender.x, defender.z);
  if (d >= HIGH_GROUND_THRESHOLD) return COMBAT.highGroundBonus;
  if (d <= -HIGH_GROUND_THRESHOLD) return COMBAT.lowGroundPenalty;
  return 1;
}

export type Approach = 'front' | 'side' | 'rear';

/**
 * Where the attacker is standing relative to the way the defender is facing.
 *
 * `facing` is the direction the defender is looking, as atan2(dx, dz) — the
 * same convention movement writes, so this stays consistent with what the
 * renderer draws.
 */
export function approachFrom(attacker: Unit, defender: Unit): Approach {
  const dx = attacker.x - defender.x;
  const dz = attacker.z - defender.z;
  if (dx === 0 && dz === 0) return 'front';
  const toAttacker = Math.atan2(dx, dz);
  let rel = toAttacker - defender.facing;
  while (rel > Math.PI) rel -= Math.PI * 2;
  while (rel < -Math.PI) rel += Math.PI * 2;
  const a = Math.abs(rel);
  if (a <= COMBAT.frontArc) return 'front';
  if (a >= Math.PI - COMBAT.rearArc) return 'rear';
  return 'side';
}

export function flankMultiplier(attacker: Unit, defender: Unit): number {
  switch (approachFrom(attacker, defender)) {
    case 'rear': return COMBAT.flankBonus;
    case 'side': return COMBAT.sideBonus;
    default: return 1;
  }
}

/**
 * Damage one attack actually deals, after everything positional.
 *
 * This is the single place the §2 pillar becomes a number: accuracy (are you
 * set up?), cohesion (are you overpacked?), elevation and facing (where are you
 * standing?) all multiply together, and none of them can be improved by
 * clicking faster.
 */
export function resolvedDamage(world: World, attacker: Unit, defender: Unit): number {
  return UNIT_TYPES[attacker.type].combat.damage
    * modifiersForUnit(world, attacker.team, attacker.type).damageMul
    * effectiveAccuracy(attacker)
    * cohesionEffectiveness(world, attacker)
    * elevationMultiplier(attacker, defender)
    * flankMultiplier(attacker, defender)
    * (1 - effectiveDefense(world, defender));
}

// --- Target acquisition and attacking (1.10) ------------------------------

function inRange(u: Unit, tx: number, tz: number, extra = 0): boolean {
  const reach = UNIT_TYPES[u.type].combat.range + u.radius + extra;
  return Math.hypot(tx - u.x, tz - u.z) <= reach;
}

/**
 * Nearest living enemy within acquire range.
 *
 * Ties are broken by entity id so the choice cannot depend on array order —
 * two peers must pick the same target from the same state (D-010).
 */
export function findTarget(world: World, unit: Unit): Unit | null {
  let best: Unit | null = null;
  let bestDist = Infinity;
  for (const other of world.units) {
    if (other.hp <= 0 || other.team === unit.team) continue;
    const d = Math.hypot(other.x - unit.x, other.z - unit.z);
    if (d > COMBAT.acquireRange) continue;
    if (d < bestDist - 1e-9 || (Math.abs(d - bestDist) <= 1e-9 && best && other.id < best.id)) {
      best = other;
      bestDist = d;
    }
  }
  return best;
}

/** Nearest enemy building in range — how a base actually falls (1.12). */
function findEnemyBuilding(world: World, unit: Unit): Building | null {
  let best: Building | null = null;
  let bestDist = Infinity;
  for (const b of world.buildings) {
    if (b.team === unit.team) continue;
    const d = Math.hypot(b.x - unit.x, b.z - unit.z);
    if (d > COMBAT.acquireRange + b.radius) continue;
    if (d < bestDist - 1e-9 || (Math.abs(d - bestDist) <= 1e-9 && best && b.id < best.id)) {
      best = b;
      bestDist = d;
    }
  }
  return best;
}

/**
 * One tick of fighting, resolved simultaneously.
 *
 * Units defend themselves without being told to — the game is about intent, not
 * about remembering to press attack. A unit already under orders keeps walking;
 * it simply also shoots whatever comes into range.
 *
 * **Two phases, and the split is load-bearing (B-005).** This previously walked
 * `world.units` applying `target.hp -= damage` in place. Because the loop skips
 * units already at zero hp, a unit earlier in the array struck, killed, and its
 * victim never swung back — so the whole engagement was decided by array
 * position. Measured before the fix: two identical mirrored 10-unit forces
 * resolved **10–0 for whichever team was pushed into `world.units` first**, in
 * exactly 384 ticks either way, and reversing only the insertion order reversed
 * the entire result.
 *
 * That is not a rounding error, it is the opposite of what §2 promises, and it
 * silently invalidated every measurement taken on top of it. Note it was also
 * perfectly *deterministic* — `determinism.test.ts` was green throughout, which
 * is the lesson: determinism says a result repeats, not that it is fair.
 *
 * So: read every attacker's intent against the state at the start of the tick,
 * then apply. Phase one mutates no hp, so cohesion, shield-wall and defense all
 * evaluate identically for every attacker regardless of where it sits in the
 * array. A unit that dies this tick still lands the blow it had already thrown,
 * which is what makes mutual destruction possible and the mirror hold.
 *
 * Shuffling the array instead would have traded a systematic bias for a
 * seed-dependent one and broken D-019's "no hidden randomness".
 */
export function stepCombat(world: World): void {
  // Accumulated per target so several attackers on one defender all land.
  const unitDamage = new Map<EntityId, number>();
  const buildingDamage = new Map<EntityId, number>();
  const add = (into: Map<EntityId, number>, id: EntityId, amount: number): void => {
    into.set(id, (into.get(id) ?? 0) + amount);
  };

  // --- Phase one: read. Nothing below writes hp. ---
  for (const u of world.units) {
    if (u.hp <= 0) continue;
    if (u.attackCd > 0) u.attackCd--;

    const target = findTarget(world, u);
    u.targetId = target?.id ?? null;

    if (u.attackCd > 0) continue;

    if (target && inRange(u, target.x, target.z, target.radius)) {
      add(unitDamage, target.id, resolvedDamage(world, u, target));
      u.attackCd = UNIT_TYPES[u.type].combat.attackTicks;
      continue;
    }

    // Nothing to shoot at, but there may be something to knock down.
    const building = findEnemyBuilding(world, u);
    if (building && inRange(u, building.x, building.z, building.radius)) {
      const mods = modifiersForUnit(world, u.team, u.type);
      add(buildingDamage, building.id, UNIT_TYPES[u.type].combat.damage
        * mods.damageMul * mods.siegeMul
        * effectiveAccuracy(u)
        * cohesionEffectiveness(world, u)
        * COMBAT.buildingDamageScale);
      u.attackCd = UNIT_TYPES[u.type].combat.attackTicks;
    }
  }

  // --- Phase two: apply. Iterating the world arrays rather than the maps
  // keeps the order of floating-point subtraction independent of insertion
  // order, which a Map's own iteration order would not be (D-010). ---
  for (const u of world.units) {
    const damage = unitDamage.get(u.id);
    if (damage !== undefined) u.hp -= damage;
  }
  for (const b of world.buildings) {
    const damage = buildingDamage.get(b.id);
    if (damage !== undefined) b.hp -= damage;
  }
}

/**
 * Close the distance to an acquired target (B-006).
 *
 * Acquire range is 9.0; a Legionnaire's weapon reach is 0.9. Without this step
 * a unit sees an enemy from ten times further than it can hit one and nothing
 * ever closes the gap — measured before the fix, two ten-unit lines thirty
 * apart stood still for 3600 ticks and dealt no damage between them, while the
 * selection card advertised "Attack Move — engage along route".
 *
 * The order contract is respected exactly as the commands define it:
 *
 * | mode | behaviour |
 * |---|---|
 * | `hold` | never moves. Hold position means hold position. |
 * | `move` | never diverts. The player named a destination. |
 * | `attackMove` | pursues, then resumes the route. |
 * | `patrol` | pursues, then resumes the leg it was walking. |
 * | `idle` | pursues in self-defence, then returns to where it was standing. |
 *
 * Workers never pursue. A mining camp that empties itself to chase a scout is
 * a worse outcome than the scout escaping, and §8.2's whole promise is that
 * workers do not need supervision.
 *
 * Pursuit is leashed to where it began rather than allowed to run: a target
 * that keeps retreating stays inside `acquireRange` forever, so an unleashed
 * chase would follow it across the map. Breaking off restores whatever
 * destination the unit already had, so fighting never silently cancels an
 * order.
 *
 * Runs after the reaper so nothing chases a corpse.
 */
export function stepPursuit(world: World): void {
  for (const u of world.units) {
    const disengage = (): void => {
      if (u.pursuitFrom) {
        // Resume the order that was interrupted, or fall back to the ground the
        // unit left. Either way it does not simply stop where the chase ended.
        u.target = u.pursuitResume ?? u.pursuitFrom;
        u.pursuitFrom = null;
        u.pursuitResume = null;
      }
    };

    if (UNIT_TYPES[u.type].isWorker || u.orderMode === 'hold' || u.orderMode === 'move') {
      disengage();
      continue;
    }

    const target = u.targetId === null
      ? null
      : world.units.find(t => t.id === u.targetId && t.hp > 0) ?? null;

    if (!target) { disengage(); continue; }

    // Already able to shoot: stand and fight rather than walking into the
    // target, which would break formation for no gain.
    if (inRange(u, target.x, target.z, target.radius)) {
      if (u.pursuitFrom) { u.target = null; }
      continue;
    }

    const anchor = u.pursuitFrom ?? { x: u.x, z: u.z };
    if (Math.hypot(target.x - anchor.x, target.z - anchor.z) > COMBAT.pursuitLeash) {
      disengage();
      continue;
    }

    if (!u.pursuitFrom) {
      u.pursuitFrom = { x: u.x, z: u.z };
      u.pursuitResume = u.target ? { x: u.target.x, z: u.target.z } : null;
    }
    u.target = { x: target.x, z: target.z };
  }
}

/**
 * Clear out the dead.
 *
 * Squad rosters, selections and build/gather jobs all reference units by id, so
 * every one of them has to be swept or they accumulate dangling ids — which
 * would diverge between peers as soon as an id were reused.
 */
export function stepReaper(world: World): void {
  const dead = new Set<EntityId>();
  for (const u of world.units) if (u.hp <= 0) dead.add(u.id);
  if (dead.size) {
    world.units = world.units.filter(u => !dead.has(u.id));
    for (const sq of world.squads) sq.memberIds = sq.memberIds.filter(id => !dead.has(id));
    for (const u of world.units) if (u.targetId !== null && dead.has(u.targetId)) u.targetId = null;
  }

  const rubble = world.buildings.filter(b => b.hp <= 0).map(b => b.id);
  if (rubble.length) {
    const gone = new Set(rubble);
    world.buildings = world.buildings.filter(b => !gone.has(b.id));
    for (const u of world.units) {
      if (u.gather && u.gather.state === 'toBase') { u.gather.state = 'idle'; u.gather.nodeId = null; }
    }
  }

  world.squads = world.squads.filter(sq => sq.memberIds.length > 0);
}

// --- Win condition (1.12, §2 "pure base destruction") ---------------------

/**
 * A team is eliminated once it holds no buildings.
 *
 * The grace period stops a match being called in the single tick between a last
 * base falling and a construction site completing — losing to a race condition
 * rather than to the opponent would be indefensible.
 */
export function stepVictory(world: World): void {
  if (world.winner) return;
  const teams: Team[] = ['player', 'rival'];
  for (const team of teams) {
    const holds = world.buildings.some(b => b.team === team)
      || world.sites.some(s => s.team === team);
    world.eliminationTicks[team] = holds ? 0 : world.eliminationTicks[team] + 1;
  }
  for (const team of teams) {
    if (world.eliminationTicks[team] > VICTORY.graceTicks) {
      world.winner = team === 'player' ? 'rival' : 'player';
      return;
    }
  }
}
