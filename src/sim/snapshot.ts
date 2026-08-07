import type { World } from '../core/types';

/**
 * Snapshot, restore and hash of the whole simulation.
 *
 * These three operations are the shared foundation under every networked
 * requirement, and they only work because `World` is plain data:
 *
 *   - **Rollback netcode** rewinds to a past tick and re-simulates with
 *     corrected input. That is `restore()` followed by N × `simStep()`.
 *   - **Replays** seek to a mid-match tick without replaying from zero, by
 *     restoring the nearest keyframe.
 *   - **Match validation / MMR** lets a server re-run a submitted match and
 *     confirm the result, which is `hash()` agreeing at the final tick.
 *   - **Desync detection** compares `hash()` between peers each tick and
 *     reports the exact tick a divergence appeared.
 *
 * The invariant that makes all of it possible: **no sim state may live
 * anywhere unreachable.** No closures, no functions, no `Map`/`Set` held on
 * `World`, no references between entities other than ids. If you add a field
 * to `World` that a structured clone cannot carry, you have broken rollback,
 * replays and validation simultaneously — and the determinism test will not
 * necessarily catch it, because a fresh sim from tick 0 still works.
 *
 * See docs/DECISIONS.md D-010.
 */

/** An opaque point-in-time copy of the simulation. */
export type Snapshot = World;

/**
 * Deep copy of the entire world.
 *
 * `structuredClone` is correct and fast enough for the current object-graph
 * state, but it allocates. If rollback ever needs to snapshot every tick at
 * 100+ units, this is the thing to replace — with a structure-of-arrays layout
 * backed by typed arrays, where a snapshot becomes a `TypedArray.set()` memcpy
 * into a ring buffer instead of a graph walk. The call sites do not change;
 * only this file does. That is the point of routing everything through here.
 */
export function snapshot(world: World): Snapshot {
  return structuredClone(world);
}

/**
 * Overwrite `world` in place from a snapshot.
 *
 * In place, not by returning a new object, because every view and system holds
 * a long-lived reference to the same `World`. Rollback that swapped the object
 * would leave the renderer pointed at an orphan.
 */
export function restore(world: World, snap: Snapshot): void {
  const fresh = structuredClone(snap);
  const bag = world as unknown as Record<string, unknown>;
  for (const k of Object.keys(bag)) delete bag[k];
  Object.assign(world, fresh);
}

/**
 * Order-independent-per-entity, order-dependent-overall hash of sim state.
 *
 * FNV-1a over the fields that actually affect the simulation. Deliberately
 * excludes `prevX`/`prevZ`/`prevFacing`, which exist only so the renderer can
 * interpolate and are not inputs to any rule — including them would make the
 * hash sensitive to presentation state.
 *
 * Floats are quantised before hashing. Two peers that agree to within 1e-6 are
 * agreeing; hashing raw bit patterns would report a desync on the last mantissa
 * bit and make the check useless in practice.
 */
export function hash(world: World): string {
  let h = 0x811c9dc5;

  const mix = (n: number): void => {
    h ^= n | 0;
    h = Math.imul(h, 0x01000193);
  };
  const mixF = (f: number): void => mix(Math.round(f * 1e6));
  const mixS = (s: string): void => {
    for (let i = 0; i < s.length; i++) mix(s.charCodeAt(i));
  };

  mix(world.tick);
  mix(world.dayStartTick);
  mix(world.nextId);
  mix(world.rngState);
  mix(world.mapSeed);
  mix(world.mapVersion);
  mixF(world.resources.player);
  mixF(world.resources.rival);
  mixS(world.winner ?? '-');
  mix(world.eliminationTicks.player); mix(world.eliminationTicks.rival);
  if (world.ai) {
    mixS(world.ai.team); mix(world.ai.nextThinkTick); mix(world.ai.attacking ? 1 : 0);
  }

  for (const u of world.units) {
    mix(u.id); mixS(u.type); mixS(u.team);
    mixF(u.x); mixF(u.z); mixF(u.facing); mixF(u.hp);
    mix(u.stillTicks);
    mixF(u.target?.x ?? 0); mixF(u.target?.z ?? 0);
    mixS(u.orderMode);
    mixF(u.patrolFrom?.x ?? 0); mixF(u.patrolFrom?.z ?? 0);
    mixF(u.patrolTo?.x ?? 0); mixF(u.patrolTo?.z ?? 0);
    mixS(u.patrolHeading);
    mix(u.gather ? 1 : 0);
    if (u.gather) {
      mixS(u.gather.state); mix(u.gather.nodeId ?? -1);
      mixF(u.gather.carrying); mix(u.gather.timer);
    }
    mix(u.build?.siteId ?? -1);
    mix(u.targetId ?? -1); mix(u.attackCd);
    // Pursuit is real intent, not derived state: the leash anchor decides when
    // a unit breaks off and the resume point decides where it goes next, so two
    // peers disagreeing about either would diverge as soon as a chase ended.
    mix(u.pursuitFrom ? 1 : 0);
    mixF(u.pursuitFrom?.x ?? 0); mixF(u.pursuitFrom?.z ?? 0);
    mix(u.pursuitResume ? 1 : 0);
    mixF(u.pursuitResume?.x ?? 0); mixF(u.pursuitResume?.z ?? 0);
  }

  for (const b of world.buildings) {
    mix(b.id); mixS(b.type); mixS(b.team); mixF(b.x); mixF(b.z); mixF(b.hp);
    for (const q of b.queue) { mixS(q.type); mix(q.ticksLeft); }
    // Rally is player intent that changes what future units do, so two peers
    // disagreeing about it would diverge the moment anything finishes training.
    mixF(b.rally.x); mixF(b.rally.z); mixS(b.rally.kind); mix(b.rally.targetId ?? -1);
    // Sorted, because object key order must never decide a hash.
    for (const k of Object.keys(b.rallyByType).sort()) {
      const r = b.rallyByType[k as keyof typeof b.rallyByType];
      if (!r) continue;
      mixS(k); mixF(r.x); mixF(r.z); mixS(r.kind); mix(r.targetId ?? -1);
    }
  }

  for (const n of world.nodes) { mix(n.id); mixF(n.amount); }
  for (const s of world.sites) { mix(s.id); mixS(s.type); mixF(s.progress); }

  // Research changes every unit's effective stats, so peers disagreeing about
  // it diverge on the next attack. Sorted: the researched list is append-order,
  // which is deterministic, but sorting makes the hash independent of the order
  // two equivalent research paths happened to complete in.
  for (const team of ['player', 'rival'] as const) {
    const t = world.tech[team];
    for (const id of [...t.researched].sort()) mixS(id);
    mixS(t.researching?.id ?? '-');
    mix(t.researching?.ticksLeft ?? -1);
  }

  for (const m of world.missions) {
    mix(m.id); mixS(m.team); mixS(m.objective); mixS(m.priority); mixS(m.status);
    mixF(m.fallback?.x ?? 0); mixF(m.fallback?.z ?? 0);
    for (const id of m.squadIds) mix(id);
  }

  for (const sq of world.squads) {
    mix(sq.id); mixS(sq.team); mix(sq.number); mix(sq.index); mix(sq.stepTicks);
    mix(sq.running ? 1 : 0); mix(sq.loop ? 1 : 0); mix(sq.dispatched ? 1 : 0);
    mixS(sq.patrolHeading);
    mixF(sq.patrolFrom?.x ?? 0); mixF(sq.patrolFrom?.z ?? 0);
    mixF(sq.patrolTo?.x ?? 0); mixF(sq.patrolTo?.z ?? 0);
    for (const m of sq.memberIds) mix(m);
    for (const st of sq.chain) mixS(st.kind);
  }

  return (h >>> 0).toString(16).padStart(8, '0');
}
