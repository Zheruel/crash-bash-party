import type { ModifierInfo, World } from './types';
import type { Look } from './look';

export type Phase = 'lobby' | 'wheel' | 'intro' | 'countdown' | 'play' | 'results' | 'final';

export interface Seat {
  clientId: number | null; // null => bot
  name: string;
  ready: boolean;
  score: number;
  look: Look;
  connected: boolean; // false while a dropped player's seat is held for them (a bot plays meanwhile)
}

export interface RoomState {
  code: string;
  phase: Phase;
  hostId: number;
  totalRounds: number; // number of mini-games in a party
  round: number;
  botLevel: number; // 0 easy, 1 normal, 2 hard
  seats: Seat[]; // always 4
  spectators: { id: number; name: string }[];
  rematch: number; // number of rematch votes
}

export type C2S =
  | { t: 'join'; room?: string; name: string; spectate?: boolean; token?: string; look?: Look }
  | { t: 'ready'; ready: boolean }
  | { t: 'seat'; take: boolean } // lobby only: take a seat / become spectator
  | { t: 'look'; look: Look }
  | { t: 'config'; rounds?: number; botLevel?: number } // host, lobby only
  | { t: 'emote'; id: number }
  | { t: 'rematch' }
  | { t: 'skip' } // host: skip the current waiting screen (wheel/intro/results)
  | { t: 'input'; seq: number; x: number; y: number; a: boolean; b: boolean; c?: boolean };

export interface SeatInfo {
  name: string;
  bot: boolean;
  look: Look;
}

export interface RoundMsg {
  t: 'round';
  round: number;
  total: number;
  showdown: boolean;
  gameId: string;
  gameName: string;
  desc: string;
  controls: string;
  modifier: ModifierInfo | null;
  seats: SeatInfo[];
}

export interface WheelMsg {
  t: 'wheel';
  round: number;
  total: number;
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
  total: number;
  showdown: boolean;
  placements: number[]; // slots best-first
  gained: number[]; // per slot, placement points (4/3/2/1, doubled in the final showdown)
  bonus: number[]; // per slot, comeback bonus point
  prev: number[]; // points before this round
  scores: number[]; // per slot, points after this round
  stars: number[]; // per slot, mini-game wins (trophies) so far
  final: boolean;
  winners: number[]; // final: most points, ties broken by trophies
  awards: Award[]; // only on the final results
}

export type S2C =
  | { t: 'joined'; id: number; code: string; token: string; resumed: boolean }
  | { t: 'room'; room: RoomState }
  | RoundMsg
  | WheelMsg
  | { t: 'phase'; phase: Phase; ms: number }
  | { t: 'snap'; tick: number; ack: number; w: World }
  | ResultsMsg
  | { t: 'emote'; slot: number; id: number }
  | { t: 'error'; msg: string };
