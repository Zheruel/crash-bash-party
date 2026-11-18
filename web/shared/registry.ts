import type { MiniGame } from './types';
import { ballDefence } from './games/ballDefence';
import { pushOff } from './games/pushOff';
import { tilePainter } from './games/tilePainter';
import { tankArena } from './games/tankArena';
import { crateToss } from './games/crateToss';
import { dashRace } from './games/dashRace';
import { ringDing } from './games/ringDing';
import { dragonDrop } from './games/dragonDrop';
import { malletMash } from './games/malletMash';
import { kegKaboom } from './games/kegKaboom';

/** Register new mini-games here (and a matching view in client/games/index.ts). */
export const GAMES: MiniGame[] = [ballDefence, pushOff, tilePainter, tankArena, crateToss, dashRace, ringDing, dragonDrop, malletMash, kegKaboom];
export const getGame = (id: string): MiniGame | undefined => GAMES.find((g) => g.id === id);
