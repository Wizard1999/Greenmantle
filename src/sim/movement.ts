import type { Unit, World } from '../core/types';
import type { MapBoundary } from './mapBoundary';
import { DT } from '../core/loop';
import { UNIT_TYPES } from '../data/units';
import { clampPointToMapBoundary } from './mapBoundary';

/**
 * Rotate `from` toward `to` by at most `maxStep` radians, the short way round.
 *
 * Pure so the wrap-around cases can be tested directly — turning from +179° to
 * −179° is a 2° adjustment, not a 358° one, and getting that backwards would
 * make units spin the long way at exactly the moments a fight is decided.
 */
export function turnToward(from: number, to: number, maxStep: number): number {
  const tau = Math.PI * 2;
  let delta = (to - from) % tau;
  if (delta > Math.PI) delta -= tau;
  if (delta < -Math.PI) delta += tau;
  if (Math.abs(delta) <= maxStep) return to;
  return from + Math.sign(delta) * maxStep;
}

export function stepMovement(u: Unit, boundary: MapBoundary): void {
  if (!u.target) return;
  const safe = clampPointToMapBoundary(boundary, u.target.x, u.target.z, u.radius + 0.05);
  u.target = safe;
  const dx = u.target.x - u.x;
  const dz = u.target.z - u.z;
  const dist = Math.hypot(dx, dz);
  const eps = UNIT_TYPES[u.type].arriveEpsilon;
  if (dist <= eps) {
    if (u.orderMode === 'patrol' && u.patrolFrom && u.patrolTo) {
      u.patrolHeading = u.patrolHeading === 'to' ? 'from' : 'to';
      const next = u.patrolHeading === 'to' ? u.patrolTo : u.patrolFrom;
      u.target = { x: next.x, z: next.z };
    } else {
      u.target = null;
      if (u.orderMode === 'move' || u.orderMode === 'attackMove') u.orderMode = 'idle';
    }
    return;
  }
  const step = Math.min(u.speed * DT, dist);
  u.x += (dx / dist) * step;
  u.z += (dz / dist) * step;
  const clamped = clampPointToMapBoundary(boundary, u.x, u.z, u.radius);
  u.x = clamped.x;
  u.z = clamped.z;
  // Facing is no longer written here. Movement never waits on a turn — the unit
  // travels the instant it is ordered — but the direction it *counts* as facing
  // is bounded, and `stepFacing` owns it.
}

/**
 * Turn every unit toward what it is doing, at its own bounded rate.
 *
 * Runs after movement so a unit that travelled this tick turns toward where it
 * went, and a stationary one turns toward what it is shooting.
 *
 * This replaces `u.facing = atan2(dx, dz)` inside `stepMovement`, which
 * rewrote facing instantly and unboundedly every tick. Two things followed from
 * that, neither designed: a defender could snap 180° in a single tick, so the
 * flanking bonus could never be earned by manoeuvre; and a unit that stopped
 * moving stopped turning *entirely*, because facing was only ever written by
 * movement. The second was load-bearing by accident — hammer-and-anvil worked
 * only because a pinned unit's facing froze. Now both are rules.
 *
 * **The two cases run at different rates, and that split is the whole point
 * (B-011).** Under a single rate the two things a facing has to be good for
 * pull in opposite directions. Travel wants a fast rate: a unit that visibly
 * lags the direction it is walking reads as sludge, and the brief is to be more
 * responsive than StarCraft rather than equally so. Re-facing under fire wants a
 * slow one, because that rate *is* the price of being caught the wrong way
 * round — and at the travel rate the price was one volley. A Legionnaire came
 * about in 30 ticks against an `attackTicks` of 24, so a defender taken
 * completely in the back was square-on before the second blow landed, and a
 * 10v10 whose defender faced entirely away resolved identically to the head-on
 * fight. Two rates cost one extra number per unit and let each case have the
 * value it needs.
 *
 * Deliberately no effect on movement itself, in either case. An order is obeyed
 * on the tick it lands and only the combat facing lags. Turning is automatic, so
 * it adds nothing a player can micro — what decides a flank is where the squad
 * was sent, which is doctrine.
 */
export function stepFacing(world: World): void {
  for (const u of world.units) {
    const def = UNIT_TYPES[u.type];
    // Travelling: look where you are going, quickly.
    if (u.x !== u.prevX || u.z !== u.prevZ) {
      u.facing = turnToward(u.facing, Math.atan2(u.x - u.prevX, u.z - u.prevZ), def.turnRate);
      continue;
    }
    // Standing and fighting: come about toward the target, slowly.
    const bearing = targetBearing(world, u);
    if (bearing === null) continue;
    u.facing = turnToward(u.facing, bearing, def.refaceRate);
  }
}

/** Direction from a unit to whatever it is currently fighting, or null when it
 *  has no target, the target is already gone, or the two are coincident. */
function targetBearing(world: World, u: Unit): number | null {
  if (u.targetId === null) return null;
  const target = world.units.find(t => t.id === u.targetId);
  if (!target) return null;
  const dx = target.x - u.x;
  const dz = target.z - u.z;
  if (dx === 0 && dz === 0) return null;
  return Math.atan2(dx, dz);
}
