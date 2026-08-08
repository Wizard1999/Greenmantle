import type { World } from '../core/types';
import { rngSeed } from '../core/rng';
import { startTickForHour } from './daynight';
import { MAP_VERSION } from './map';
import { stepProduction } from './production';
import { stepBuild, stepConstruction } from './construction';
import { stepGather } from './economy';
import { stepFacing, stepMovement } from './movement';
import { stepSquads } from './squads';
import { stepCombat, stepPursuit, stepReaper, stepSettle, stepVictory } from './combat';
import { stepAi } from './ai';
import { mapBoundaryForSeed } from './mapBoundary';
import { stepMissions } from './missions';
import { createTechState, stepTech } from './tech';

export function createWorld(seed: number, startHour = 8, mapSeed = seed): World {
  return {
    seed,
    rngState: rngSeed(seed),
    mapSeed: rngSeed(mapSeed),
    mapVersion: MAP_VERSION,
    tick: 0,
    dayStartTick: startTickForHour(startHour),
    nextId: 1,
    units: [],
    buildings: [],
    nodes: [],
    sites: [],          // construction in progress
    scenery: [],
    squads: [],         // persistent groups running behaviour chains
    resources: { player: 0, rival: 0 },
    winner: null,
    eliminationTicks: { player: 0, rival: 0 },
    // Deliberately null. A world is just a world; who plays it is match setup,
    // not world construction. Baking an opponent into createWorld() would mean
    // every test, replay and headless simulation silently ran against an AI.
    ai: null,
    missions: [],
    tech: { player: createTechState(), rival: createTechState() },
  };
}

export function simStep(world: World): void {
  world.tick++;
  for (const u of world.units) {
    u.prevX = u.x; u.prevZ = u.z; u.prevFacing = u.facing;
  }
  if (world.ai) stepAi(world, world.ai);               // the opponent decides first
  stepTech(world);
  stepProduction(world);
  stepConstruction(world);
  stepSquads(world);                                   // standing orders first
  for (const u of world.units) stepGather(world, u);   // decides where to go
  for (const u of world.units) stepBuild(world, u);    // ...or where to build
  const boundary = mapBoundaryForSeed(world.mapSeed);
  for (const u of world.units) stepMovement(u, boundary); // goes there, never off the table
  stepFacing(world);                                   // and comes about at its own rate
  stepSettle(world);                                   // ...and settles, or doesn't
  stepCombat(world);                                   // then fights
  stepReaper(world);                                   // clear the dead before anything reads them
  stepPursuit(world);                                  // close on what is still standing (B-006)
  stepMissions(world);                                 // drop squad ids the reaper just removed
  stepVictory(world);                                  // and see if that ended it
}
