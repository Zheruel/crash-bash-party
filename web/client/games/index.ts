import type { ClientMiniGame } from './types';
import { createBallDefenceView } from './ballDefence';
import { createCrateTossView } from './crateToss';
import { createDashRaceView } from './dashRace';
import { createPushOffView } from './pushOff';
import { createTankArenaView } from './tankArena';
import { createTilePainterView } from './tilePainter';
import { createRingDingView } from './ringDing';
import { createDragonDropView } from './dragonDrop';
import { createMalletMashView } from './malletMash';
import { createKegKaboomView } from './kegKaboom';

/** Client view factories, keyed by the shared MiniGame id. */
export const VIEWS: Record<string, () => ClientMiniGame> = {
  ballDefence: createBallDefenceView,
  pushOff: createPushOffView,
  tilePainter: createTilePainterView,
  tankArena: createTankArenaView,
  crateToss: createCrateTossView,
  dashRace: createDashRaceView,
  ringDing: createRingDingView,
  dragonDrop: createDragonDropView,
  malletMash: createMalletMashView,
  kegKaboom: createKegKaboomView,
};
