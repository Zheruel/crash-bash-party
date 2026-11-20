import type { ModifierInfo, World } from './types';
import type { Look } from './look';

export type Phase = 'lobby' | 'wheel' | 'intro' | 'countdown' | 'play' | 'results' | 'final';
export type WinCondition = 'rounds' | 'cups';

// USA Game Options: left/right stops at 2 and 7, with a starting target of 3.
export const MIN_CUPS_TO_WIN = 2;
export const MAX_CUPS_TO_WIN = 7;
export const DEFAULT_CUPS_TO_WIN = 3;

export function isCupsToWin(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_CUPS_TO_WIN && value <= MAX_CUPS_TO_WIN;
}

export interface Seat {
  clientId: number | null; // null => bot
  name: string;
  ready: boolean;
  score: number;
  look: Look;
  connected: boolean; // false while a dropped player's seat is held for them (a bot plays meanwhile)
}

export interface StageOption {
  id: string; // game id, or game id and variant joined by ':'
  gameId: string;
  variantId: string | null;
  name: string;
}

export interface MatchConfig {
  rounds?: number;
  winCondition?: WinCondition;
  cupsToWin?: number;
  botLevel?: number;
  twists?: boolean;
  stage?: string | null; // null restores automatic stage selection
}

export interface RoomState {
  code: string;
  phase: Phase;
  hostId: number;
  totalRounds: number; // number of mini-games in a party
  round: number;
  winCondition?: WinCondition;
  cupsToWin?: number;
  twists?: boolean;
  botLevel: number; // 0 easy, 1 normal, 2 hard
  stage?: string | null;
  stages?: StageOption[]; // available choices, omitted by older hosts
  seats: Seat[]; // always 4
  spectators: { id: number; name: string }[];
  rematch: number; // number of rematch votes
}

export type C2S =
  | { t: 'join'; room?: string; name: string; spectate?: boolean; token?: string; look?: Look }
  | { t: 'ready'; ready: boolean }
  | { t: 'seat'; take: boolean } // lobby only: take a seat / become spectator
  | { t: 'look'; look: Look }
  | ({ t: 'config' } & MatchConfig) // host, lobby only
  | { t: 'emote'; id: number }
  | { t: 'rematch' }
  | { t: 'skip' } // host: skip the current waiting screen (wheel/intro/results)
  | { t: 'input'; round?: number; opening?: true; seq: number; x: number; y: number; a: boolean; b: boolean; c?: boolean; d?: boolean; l?: boolean; r?: boolean };

export interface SeatInfo {
  name: string;
  bot: boolean;
  look: Look;
}

export const COUNT_LABELS = ['3', '2', '1'] as const;
export const COUNT_FRAMES = 28;
export const NUMBERED_COUNTDOWN_TICKS = COUNT_LABELS.length * COUNT_FRAMES;

export interface RoundMsg {
  t: 'round';
  round: number;
  total: number; // configured Party round count
  cupsToWin?: number; // present in a first-to-cups battle
  showdown: boolean;
  gameId: string;
  gameName: string;
  countdownLeadTicks?: number; // visible arena before the first numeral
  variant?: { id: string; name: string } | null;
  desc: string;
  controls: string;
  modifier: ModifierInfo | null;
  seats: SeatInfo[];
}

export interface WheelMsg {
  t: 'wheel';
  round: number;
  total: number; // configured Party round count
  cupsToWin?: number;
  showdown: boolean;
  options: { id: string; name: string }[];
  pick: number; // index into options
  variant: { id: string; name: string } | null; // real level picked, e.g. CRASHBALL
  modifier: ModifierInfo | null;
  ms: number;
}

export interface Award {
  id: string;
  title: string;
  desc: string;
  slot: number;
  value: number;
}

export interface ResultsMsg {
  t: 'results';
  round: number;
  total: number; // configured Party round count
  cupsToWin?: number;
  showdown: boolean;
  draw?: boolean; // a tied round awards no placement points or trophy
  placements: number[]; // slots best-first
  gained: number[]; // per slot, Party placement points or battle cups won this round
  bonus: number[]; // per slot, comeback bonus point
  prev: number[]; // points before this round
  scores: number[]; // per slot, points after this round
  stars: number[]; // per slot, mini-game wins (trophies or cups) so far
  final: boolean;
  winners: number[]; // final: cup battle winner or Party leaders after trophy tiebreak
  awards: Award[]; // only on the final results
}

export type S2C =
  | { t: 'joined'; id: number; code: string; token: string; resumed: boolean }
  | { t: 'room'; room: RoomState }
  | RoundMsg
  | WheelMsg
  | { t: 'phase'; phase: Phase; ms: number; elapsedMs?: number }
  | { t: 'snap'; round?: number; tick: number; ack: number; w: World }
  | ResultsMsg
  | { t: 'emote'; slot: number; id: number }
  | { t: 'error'; msg: string };
