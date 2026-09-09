import * as THREE from 'three';
import type { EntityId, Team, UnitTypeKey, World } from '../core/types';
import { MARK } from './palette';

/**
 * Acknowledgement that a blow landed and that something died.
 *
 * `stepCombat` subtracts hit points and `stepReaper` removes the corpse in the
 * same tick, so before this file a unit went from whole to absent between two
 * frames with nothing in between. BENCHMARKS §6 puts it plainly: a death
 * animation finishes before the geometry leaves the scene. A death the player
 * does not see is a fight they cannot read, and it is the reason a losing
 * engagement looked identical to a winning one until the army was gone.
 *
 * The simulation is not touched and is not asked for events. It has no event
 * bus and adding one would put presentation concerns inside the deterministic
 * core for no gain, since every fact needed is already in the tick: hit points
 * fell, or an id that existed last frame does not exist now. So this module
 * remembers what it saw and diffs. `observeDamage` is a pure function over two
 * snapshots and is tested as one.
 *
 * §2.6 governs what may then be drawn:
 *
 * - **Pooled.** One instanced batch allocated at startup, nothing allocated per
 *   event. `commandFeedback.ts` builds three meshes and three materials for
 *   every click; at combat rates that is a garbage-collection pause during the
 *   busiest frames of the match.
 * - **Bounded.** Effects are keyed to the *target*, so several attackers
 *   converging on one defender produce one impact, and the count can never
 *   exceed the number of units attacking.
 * - **Short.** Lifetimes are under the shortest attack interval in the roster
 *   (the Legionnaire's 24 ticks), so effects cannot accumulate.
 * - **Not a micro tell.** Additive warm light and bone dust. No damage numbers,
 *   no low-health screen effect, nothing asking to be reacted to inside a
 *   second — §2.6 rules those out and §§2 and 4 say why.
 */

/** Ticks a hit stays lit. Under the Legionnaire's 24-tick attack interval, so
 *  one attacker can never have two impacts alive at once. */
const HIT_LIFE = 13;
/** A body coming apart takes longer than a blow lands. Still inside one
 *  Legionnaire attack cycle. */
const DEATH_LIFE = 22;
/** How long a bar stays flashed after its owner is hit, in ticks. Short: this
 *  is the same-frame damage read §2.6 asks for, not an alert. Five ticks is a
 *  sixth of a second — under sustained fire a bar is lit for well under half
 *  the time, which is what keeps the flash reading as an event. */
const FLASH_LIFE = 5;
/** Floating-point damage means an exact comparison would fire on rounding. */
const DAMAGE_EPSILON = 0.001;

export type DamageKind = 'unit' | 'building';

export interface DamageEvent {
  kind: DamageKind;
  id: EntityId;
  team: Team;
  x: number;
  z: number;
  /** Hit points lost since the previous observation. For a death, what was
   *  left when it was last seen. */
  amount: number;
  /** The entity is no longer in the world. */
  fatal: boolean;
  /** Present for units, so a caller can size the death effect to the body. */
  unitType?: UnitTypeKey;
}

interface Remembered {
  hp: number;
  x: number;
  z: number;
  team: Team;
  unitType?: UnitTypeKey;
}

export interface HealthMemory {
  units: Map<EntityId, Remembered>;
  buildings: Map<EntityId, Remembered>;
  /** The tick the memory describes. A world that has gone backwards is a
   *  restore or a replay scrub, not a massacre. */
  tick: number;
  seeded: boolean;
}

export function createHealthMemory(): HealthMemory {
  return { units: new Map(), buildings: new Map(), tick: -1, seeded: false };
}

/**
 * Diff the world against what was last seen and report what happened.
 *
 * Two cases are deliberately silent. The first observation of a world only
 * seeds the memory — otherwise loading a save would spray impacts over an army
 * that has been standing still since the file was written. And a world whose
 * tick has gone backwards has been restored or scrubbed, so the memory is
 * rebuilt without emitting: the sandbox rewinding forty ticks is not forty
 * deaths.
 */
export function observeDamage(memory: HealthMemory, world: World): DamageEvent[] {
  const rewound = world.tick < memory.tick;
  const quiet = !memory.seeded || rewound;

  const events: DamageEvent[] = [];
  const seenUnits = new Set<EntityId>();
  const seenBuildings = new Set<EntityId>();

  for (const u of world.units) {
    seenUnits.add(u.id);
    const before = memory.units.get(u.id);
    if (!quiet && before !== undefined && u.hp < before.hp - DAMAGE_EPSILON) {
      events.push({
        kind: 'unit', id: u.id, team: u.team, x: u.x, z: u.z,
        amount: before.hp - u.hp, fatal: false, unitType: u.type,
      });
    }
    memory.units.set(u.id, { hp: u.hp, x: u.x, z: u.z, team: u.team, unitType: u.type });
  }
  for (const b of world.buildings) {
    seenBuildings.add(b.id);
    const before = memory.buildings.get(b.id);
    if (!quiet && before !== undefined && b.hp < before.hp - DAMAGE_EPSILON) {
      events.push({
        kind: 'building', id: b.id, team: b.team, x: b.x, z: b.z,
        amount: before.hp - b.hp, fatal: false,
      });
    }
    memory.buildings.set(b.id, { hp: b.hp, x: b.x, z: b.z, team: b.team });
  }

  for (const [id, last] of memory.units) {
    if (seenUnits.has(id)) continue;
    memory.units.delete(id);
    if (quiet) continue;
    events.push({
      kind: 'unit', id, team: last.team, x: last.x, z: last.z,
      amount: Math.max(0, last.hp), fatal: true, unitType: last.unitType,
    });
  }
  for (const [id, last] of memory.buildings) {
    if (seenBuildings.has(id)) continue;
    memory.buildings.delete(id);
    if (quiet) continue;
    events.push({
      kind: 'building', id, team: last.team, x: last.x, z: last.z,
      amount: Math.max(0, last.hp), fatal: true,
    });
  }

  memory.tick = world.tick;
  memory.seeded = true;
  return events;
}

// --- The pooled effect batch ---------------------------------------------

/** Sized for the 100-unit target: every unit attacking at once, on distinct
 *  targets, cannot fill it. One allocation, at startup. */
const EFFECT_CAPACITY = 192;

interface Effect {
  x: number;
  y: number;
  z: number;
  born: number;
  life: number;
  size: number;
  color: THREE.Color;
}

export interface CombatFeedback {
  /** Diff the world, spawn effects, and remember which entities were hit.
   *  `simTime` is `world.tick + alpha` — the sim clock, so effects freeze when
   *  the loop is paused and play at quarter speed in the sandbox rather than
   *  running on wall-clock behind a frozen board. */
  observe: (world: World, simTime: number, heightAt: (x: number, z: number) => number) => DamageEvent[];
  /** A death, or any other reason a body should come apart. Called by
   *  `unitViews` as it starts a corpse sinking. */
  emitDeath: (x: number, y: number, z: number, size: number) => void;
  update: (simTime: number) => void;
  /** 0..1 emphasis for an entity's bar, decaying after a hit. */
  flashOf: (kind: DamageKind, id: EntityId) => number;
  liveCount: () => number;
  /** Draw calls the layer costs while something is on screen. Zero when idle. */
  drawCalls: () => number;
  dispose: () => void;
}

export function createCombatFeedback(scene: THREE.Scene): CombatFeedback {
  const memory = createHealthMemory();
  const pool: Effect[] = [];
  for (let i = 0; i < EFFECT_CAPACITY; i++) {
    pool.push({ x: 0, y: 0, z: 0, born: 0, life: 0, size: 0, color: MARK.hit });
  }
  let live = 0;
  let now = 0;
  const flashes = new Map<string, number>();

  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(
    [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  geo.setIndex([0, 1, 2, 2, 3, 0]);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

  const anchors = new Float32Array(EFFECT_CAPACITY * 3);
  const colors = new Float32Array(EFFECT_CAPACITY * 3);
  const ages = new Float32Array(EFFECT_CAPACITY);
  const sizes = new Float32Array(EFFECT_CAPACITY);
  const attribute = (name: string, array: Float32Array, size: number): THREE.InstancedBufferAttribute => {
    const attr = new THREE.InstancedBufferAttribute(array, size);
    attr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute(name, attr);
    return attr;
  };
  const aAnchor = attribute('aAnchor', anchors, 3);
  const aColor = attribute('aColor', colors, 3);
  const aAge = attribute('aAge', ages, 1);
  const aSize = attribute('aSize', sizes, 1);
  geo.instanceCount = 0;

  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    // Additive: an impact is light arriving, so it can brighten the board but
    // can never make anything on it harder to see.
    blending: THREE.AdditiveBlending,
    uniforms: {},
    vertexShader: /* glsl */`
      attribute vec3 aAnchor;
      attribute vec3 aColor;
      attribute float aAge;
      attribute float aSize;
      varying vec2 vUv;
      varying vec3 vColor;
      varying float vAge;
      void main() {
        vUv = uv;
        vColor = aColor;
        vAge = aAge;
        vec4 mv = modelViewMatrix * vec4(aAnchor, 1.0);
        // Expands as it fades, which is what makes a puff read as dispersing
        // rather than as a light being switched off.
        mv.xy += position.xy * (aSize * (0.55 + aAge * 1.15));
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */`
      #include <common>
      varying vec2 vUv;
      varying vec3 vColor;
      varying float vAge;
      void main() {
        float d = length(vUv - 0.5) * 2.0;
        float core = 1.0 - smoothstep(0.0, 1.0, d);
        float a = core * core * (1.0 - vAge);
        if (a < 0.004) discard;
        gl_FragColor = vec4(vColor * a, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });

  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 24;
  mesh.visible = false;
  scene.add(mesh);

  function spawn(x: number, y: number, z: number, life: number, size: number, color: THREE.Color): void {
    // Full pool drops the newest rather than evicting: an effect already on
    // screen disappearing is more visible than one that never appeared.
    if (live >= EFFECT_CAPACITY) return;
    const e = pool[live]!;
    e.x = x; e.y = y; e.z = z;
    e.born = now;
    e.life = life;
    e.size = size;
    e.color = color;
    live++;
  }

  return {
    observe(world, simTime, heightAt) {
      now = simTime;
      const events = observeDamage(memory, world);
      for (const event of events) {
        const y = heightAt(event.x, event.z);
        if (event.fatal) {
          // A dying building leaves a larger cloud than a body; a dying unit's
          // effect is emitted by `unitViews` as the corpse starts to sink, so
          // the dust and the sinking begin on the same frame.
          if (event.kind === 'building') spawn(event.x, y + 1.2, event.z, DEATH_LIFE, 3.4, MARK.death);
        } else {
          const scale = event.kind === 'building' ? 1.5 : 0.85;
          spawn(event.x, y + (event.kind === 'building' ? 1.2 : 1.0), event.z, HIT_LIFE, scale, MARK.hit);
        }
        flashes.set(`${event.kind}:${event.id}`, simTime);
      }
      return events;
    },
    emitDeath(x, y, z, size) {
      spawn(x, y, z, DEATH_LIFE, size, MARK.death);
    },
    update(simTime) {
      now = simTime;
      // Compact first, upload second. Doing both in one downward pass leaves
      // the element swapped into a freed slot carrying the attributes of the
      // slot it came from — a hit that visibly teleports.
      for (let i = live - 1; i >= 0; i--) {
        const e = pool[i]!;
        const age = (simTime - e.born) / e.life;
        // A negative age is the clock going backwards: a restore or a scrub,
        // not an effect that has not happened yet.
        if (age >= 1 || age < 0) {
          const last = pool[live - 1]!;
          pool[live - 1] = e;
          pool[i] = last;
          live--;
        }
      }
      for (let i = 0; i < live; i++) {
        const e = pool[i]!;
        anchors[i * 3] = e.x;
        anchors[i * 3 + 1] = e.y;
        anchors[i * 3 + 2] = e.z;
        colors[i * 3] = e.color.r;
        colors[i * 3 + 1] = e.color.g;
        colors[i * 3 + 2] = e.color.b;
        ages[i] = Math.min(1, Math.max(0, (simTime - e.born) / e.life));
        sizes[i] = e.size;
      }
      geo.instanceCount = live;
      mesh.visible = live > 0;
      aAnchor.needsUpdate = true;
      aColor.needsUpdate = true;
      aAge.needsUpdate = true;
      aSize.needsUpdate = true;

      for (const [key, at] of flashes) {
        if (simTime - at >= FLASH_LIFE || simTime < at) flashes.delete(key);
      }
    },
    flashOf(kind, id) {
      const at = flashes.get(`${kind}:${id}`);
      if (at === undefined) return 0;
      const t = (now - at) / FLASH_LIFE;
      return t < 0 || t >= 1 ? 0 : 1 - t;
    },
    liveCount: () => live,
    drawCalls: () => (live > 0 ? 1 : 0),
    dispose() {
      scene.remove(mesh);
      geo.dispose();
      material.dispose();
    },
  };
}
