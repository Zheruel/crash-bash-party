import type * as THREE from 'three';
import type { Body, GameEvent, World } from '../../shared/types';
import type { Look } from '../../shared/look';
import type { AssetRequest, AssetSource } from '../assets';
import type { HudSprite } from '../ui/ps1hud';
import type { CrashballFlash } from '../../shared/games/ballDefence';

export interface RenderContext {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  assets: AssetSource;
  /** Local player's slot, or null when spectating. */
  mySlot: number | null;
  /** Re-aim the camera so a play area of this radius fits the screen. */
  frame(radius: number): void;
  /** Per-slot player info for this round (name, appearance, bot flag). */
  seats: { name: string; look: Look; bot: boolean }[];
  /** Wall-clock seconds, monotonic (for cosmetic animation). */
  time: number;
  /** Host result-phase start in local clock seconds, for rebuilding a late join from the terminal snapshot. */
  resultReplayAt?: number;
  /** Remaining 30 Hz countdown frames before the first playable snapshot. */
  countdownTicksLeft?: number;
  /** Ask the shell for a screen shake (0..~1; 0.3 = bump, 1 = KO). */
  shake?(amount: number): void;
}

/** World as seen by the renderer: interpolated bodies, latest game data. */
export interface RenderWorld extends World {
  bodies: Body[];
  /** Ballistix marker meshes at the same interpolated tick as the ball positions. */
  ballistixMarkers?: { lights: number; cool: number[]; tick: number; flashes?: CrashballFlash[] };
  /** Locally replayed inputs, for the local actor and carried objects. */
  predicted?: World;
}

/**
 * Client-side half of a mini-game plugin (the shared half is `MiniGame`).
 * A fresh instance is created per round via the factory in games/index.ts.
 */
export interface ClientMiniGame {
  id: string;
  /** Art to preload from /assets; anything missing falls back to placeholders. */
  assets?: AssetRequest;
  /**
   * Preload Crash Bash catalog models (loadCatalog + ready(refs)). The shell should await this
   * before init(); if it doesn't, the view still works (placeholders, swapped for real models when loaded).
   */
  preload?(): Promise<void>;
  init(ctx: RenderContext, world: RenderWorld): void;
  render(ctx: RenderContext, world: RenderWorld, dt: number): void;
  /** One-shot sim event (impact, goal, paint...) -> particles, shake, floating text. Call once per new event. */
  onEvent?(ctx: RenderContext, e: GameEvent): void;
  /** Short per-player status text for the scoreboard (e.g. lives). */
  hud?(world: RenderWorld, slot: number): string;
  /** The real game's own 2D HUD for this frame (replaces the party cards and clock while playing). */
  ps1Hud?(world: RenderWorld, ctx: RenderContext): HudSprite[];
  dispose(ctx: RenderContext): void;
}
