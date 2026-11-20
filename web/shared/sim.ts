import { DT, type InputState, type MiniGame, type Modifier, type Params, type SlotInfo, type World } from './types';

export function defaultParams(): Params {
  return { gravity: 1, speed: 1, friction: 1, ballScale: 1, playerScale: 1, mirror: false, bounces: 2, fireRate: 1, brush: 0, spawnRate: 1, boost: 1 };
}

export function createWorld(game: MiniGame, players: SlotInfo[], modifiers: Modifier[], seed: number, variant?: string): World {
  const params = defaultParams();
  for (const m of modifiers) m.apply(params);
  const world: World = { tick: 0, time: 0, rng: seed >>> 0, nextId: 1, params, bodies: [], ev: [], evId: 1, data: variant ? { variant } : {} };
  game.setup(world, players, modifiers);
  return world;
}

/**
 * The one deterministic step used by the server and by client prediction.
 * Mirrored controls are applied here, so bot inputs (server-side) are
 * pre-flipped by the caller when `params.mirror` is set.
 */
export function stepWorld(world: World, game: MiniGame, inputs: (InputState | null | undefined)[], dt = DT): void {
  const inp = world.params.mirror ? inputs.map((i) => (i ? { ...i, x: -i.x, y: -i.y, l: i.r, r: i.l } : i)) : inputs;
  game.step(world, inp, dt);
  world.tick++;
  world.time += dt;
  if (world.ev.length && world.tick - world.ev[0].t > EVENT_TTL) world.ev = world.ev.filter((e) => world.tick - e.t <= EVENT_TTL);
}

const EVENT_TTL = 20;

export function emptyWorld(): World {
  return { tick: 0, time: 0, rng: 1, nextId: 1, params: defaultParams(), bodies: [], ev: [], evId: 1, data: {} };
}

export function roundOver(game: MiniGame, world: World): boolean {
  return game.isOver(world) || (!game.settlesAfterTimeout && world.time >= game.maxTime);
}

export const cloneWorld = (w: World): World => structuredClone(w);
