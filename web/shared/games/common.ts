// Small helpers shared by the mini-games (kept out of physics.ts, which other code owns).
import { discRandomState, drawDiscRandom, rand } from '../physics';
import { MAX_SEATS, type World } from '../types';

export interface Variant { id: string; name: string }
export const TAU = Math.PI * 2;

interface PlayerDispatch {
  updateOrders: number[][];
  random: [number, number];
}

/** FUN_80085650 builds 16 rows by swapping each seat with any of the four seats. */
export function createPlayerDispatch(seed: number): PlayerDispatch {
  const random = discRandomState(seed);
  return { random, updateOrders: shufflePlayerOrders(random) };
}

export function shufflePlayerOrders(random: [number, number]): number[][] {
  return Array.from({ length: 16 }, () => {
    const order = Array.from({ length: MAX_SEATS }, (_, seat) => seat);
    for (let seat = 0; seat < MAX_SEATS; seat++) {
      const other = drawDiscRandom(random, MAX_SEATS);
      [order[seat], order[other]] = [order[other], order[seat]];
    }
    return order;
  });
}

/** FUN_80083e8c draws one row per dispatch. Older worlds seed from their saved arena RNG. */
export function nextPlayerOrder(seed: number, dispatch: Partial<PlayerDispatch>): readonly number[] {
  let orders = dispatch.updateOrders;
  if (!orders) {
    const generated = createPlayerDispatch(seed);
    Object.assign(dispatch, generated);
    orders = generated.updateOrders;
  }
  const random = dispatch.random ??= discRandomState(seed);
  return orders[drawDiscRandom(random, orders.length)];
}

// FUN_8007b8d4 starts 27 play ticks after GO and draws the BCD digits before subtracting two subframes.
export const VERSUS_CLOCK_END = 27 + (90 - 1) * 30 + 2;
export function versusClock(tick: number): number {
  return Math.max(0, 90 - Math.ceil(Math.max(0, tick - 28) / 30));
}

/** The clock checks the previous HUD digits before the HUD counts this frame's points. */
export function tickVersusTally(score: number[], shown: number[], tick: number, openingPhase: number, countEveryTickFrom = VERSUS_CLOCK_END): boolean {
  const expired = tick >= VERSUS_CLOCK_END;
  const dispatch = expired && shown.every((digits, slot) => digits === score[slot]);
  const count = tick >= countEveryTickFrom || (tick + openingPhase) % 4 === 0;
  for (let slot = 0; slot < score.length; slot++) {
    score[slot] = Math.max(0, Math.min(999, score[slot]));
    if (count) shown[slot] += Math.sign(score[slot] - shown[slot]);
  }
  return dispatch;
}

/** Mallet Mash and Keg Kaboom keep awarded points on the individual player records. */
export function tickPlayerTally(players: ({ score: number } | null)[], shown: number[], tick: number, openingPhase: number, countEveryTickFrom = VERSUS_CLOCK_END): boolean {
  const scores = shown.map((_, slot) => players[slot]?.score ?? 0);
  const dispatch = tickVersusTally(scores, shown, tick, openingPhase, countEveryTickFrom);
  players.forEach((player, slot) => { if (player) player.score = scores[slot]; });
  return dispatch;
}

/** Smallest signed angle from a to b. */
export const angDiff = (a: number, b: number) => {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
};

/**
 * Choose the level variant for a round. If `w.data.variant` is already set to a valid id before
 * setup() runs (test harnesses / dev pages), it is honoured; otherwise it is drawn from world.rng.
 */
export function pickVariant(w: World, variants: Variant[]): string {
  const forced = w.data?.variant;
  if (typeof forced === 'string' && variants.some((v) => v.id === forced)) return forced;
  return variants[Math.min(variants.length - 1, Math.floor(rand(w) * variants.length))].id;
}
