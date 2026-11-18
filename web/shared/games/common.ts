// Small helpers shared by the mini-games (kept out of physics.ts, which other code owns).
import { rand } from '../physics';
import type { World } from '../types';

export interface Variant { id: string; name: string }
export const TAU = Math.PI * 2;

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
