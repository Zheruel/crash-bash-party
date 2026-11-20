// Core shared types. Everything in `World` is plain JSON so it can be cloned,
// snapshotted over the wire and re-simulated for client prediction.

export const TICK_RATE = 30;
export const DT = 1 / TICK_RATE;
export const MAX_SEATS = 4;
/** Fallback slot colours (players normally pick their own, see look.ts). */
export const SLOT_COLORS = ['#ff5a4f', '#3fa7ff', '#ffd23f', '#4cd964'];
/** Points awarded by placement (index 0 = 1st place). */
export const POINTS = [4, 3, 2, 1];

/** Raw controller state. x/y are stick axes in [-1,1]; y>0 means "down" (towards +z). */
export interface InputState {
  x: number;
  y: number;
  /** primary button: jump */
  a: boolean;
  /** secondary button: dash / bump */
  b: boolean;
  /** Third action, used to taunt in Tank Wars and jump in Crate Crush. */
  c?: boolean;
  /** Fourth face button, used for the Swamp Fox shield. */
  d?: boolean;
  /** shoulder buttons (keyboard Q / E, L1 / R1): turn the turret in Tank Wars */
  l?: boolean;
  r?: boolean;
}
export interface Input extends InputState {
  seq: number;
}
export const IDLE: InputState = { x: 0, y: 0, a: false, b: false };

export interface Body {
  id: number;
  kind: string; // 'player' | 'ball' | ...
  slot: number; // owning player slot, -1 for none
  x: number;
  y: number; // height above ground
  z: number;
  vx: number;
  vy: number;
  vz: number;
  r: number; // radius on the XZ plane
  m: number; // mass
  face: number; // yaw (radians, 0 = +z)
  alive: boolean;
  fall: boolean; // player has left the platform and is falling
  cd: number; // dash cooldown (s)
  dash: number; // remaining dash "armour" time (s)
}

/** Numeric knobs that modifiers tweak; games read these. */
export interface Params {
  gravity: number;
  speed: number;
  friction: number; // multiplies ground grip (low = slippery)
  ballScale: number;
  playerScale: number;
  mirror: boolean;
  /** extra wall bounces for tank shots */
  bounces: number;
  /** multiplies fire rate (tanks) */
  fireRate: number;
  /** paint brush size bonus (tile painter) */
  brush: number;
  /** multiplies crate spawn rate */
  spawnRate: number;
  /** boost pad strength multiplier (dash race) */
  boost: number;
}

/**
 * One-shot happening in the sim (impact, goal, paint...). Games push these via
 * physics.emit(); clients turn them into sound, particles, shake and hit-stop.
 * s = affected slot (-1 none), o = other slot (e.g. attacker), v = magnitude 0..~1+.
 */
export interface GameEvent {
  y?: number; // world-space height, measured upwards from the arena floor
  yaw?: number; // world-space orientation for a directed effect
  id: number;
  t: number; // tick
  k: string;
  x: number;
  z: number;
  s: number;
  o: number;
  v: number;
}

export interface World {
  /** The authority has stopped simulating this round, including a configured time cap. */
  finished?: true;
  tick: number;
  time: number;
  rng: number;
  nextId: number;
  params: Params;
  bodies: Body[];
  /** Recent events (last ~0.7 s), newest last. Ids grow monotonically. */
  ev: GameEvent[];
  evId: number;
  /** Game-specific state (lives, elimination ticks, ...). Must stay JSON-serialisable. */
  data: Record<string, any>;
}

export interface SlotInfo {
  slot: number;
  name: string;
  bot: boolean;
  /** Index into look.ts CHARACTERS (games with per-character stats use it; may be absent in tests). */
  char?: number;
  /** Bot difficulty 0 easy / 1 normal / 2 hard (only for bot slots; games with their own AI inside step() use it). */
  level?: number;
}

export interface ModifierInfo {
  id: string;
  name: string;
  desc: string;
}

export interface Modifier extends ModifierInfo {
  /** Restrict to these game ids (default: all). */
  appliesTo?: string[];
  apply(p: Params): void;
}

/**
 * Mini-game plugin (server + client-side prediction run this identically).
 * `inputs` is indexed by slot; null/undefined means idle (bot, spectator, unknown).
 */
export interface MiniGame {
  id: string;
  name: string;
  /** Versus objective shown on the intro card. */
  description: string;
  variantDescriptions?: Record<string, string>;
  /** Short control hints with key tokens, shown on the intro card. */
  controls: string;
  variantControls?: Record<string, string>;
  /** Level variants of the real game (e.g. CRASHBALL / BEACH BALL ...). setup() picks one from world.rng and stores its id in world.data.variant. */
  variants?: { id: string; name: string }[];
  /** Hard time limit in seconds; at the limit placements() is taken from current state. */
  maxTime: number;
  /** The native finish handler may wait for the displayed scores after the clock reaches zero. */
  settlesAfterTimeout?: boolean;
  setup(world: World, players: SlotInfo[], modifiers: Modifier[]): void;
  /** Remember held controls at GO so the first live step can detect new presses. */
  primeCountdownPad?(world: World, slot: number, input: InputState): void;
  step(world: World, inputs: (InputState | null | undefined)[], dt: number): void;
  isOver(world: World): boolean;
  /** Slot indices, best first. Must be valid at any moment (used on timeout). */
  placements(world: World): number[];
  /** Original individual-versus tie rule. The order is the result of placements(). */
  isDraw?(world: World, order: number[]): boolean;
  /** Optional AI for empty slots (host-side only). */
  bot?(world: World, slot: number): InputState;
}
