import { animStart, animStep, kkStartFall, kkStepJump, kkTurn, type KP } from '../../shared/games/kegKaboom';

const IDLE = 0x71, RUN = 0x72, HIT = 0x73, LOSER = 0x74, WINNER = 0x75;
const FALL = 0x7a, LAND = 0x7b;
const HIT_IDLE = 0, HIT_FALL = 5, HIT_LAND = 7;
const IDLE_SCRIPT = 0x61, FALL_SCRIPT = 0x66, LAND_SCRIPT = 0x67;
const WIN_READY = 0x6b, WIN_CHEER = 0x6a;

// FUN_80085718 requests the winner's extra animation from disc. FUN_80085890
// changes scripts when it arrives (11–13 ticks in the L30 USA traces).
const CHEER_DELAY = [0, 12, 12, 13, 12, 12, 12, 12, 11];

export class KegResultPlayer {
  readonly player: KP;
  private entered = -1;

  constructor(player: KP, private readonly outcome: 'win' | 'lose' | 'draw') {
    this.player = { ...player, an: { ...player.an } };
  }

  get losing() { return this.player.st === LOSER; }
  get celebrating() { return this.player.st === WINNER; }
  get enteredResult() { return this.losing || this.celebrating; }

  scale(frame: number) {
    return this.losing ? Math.max(3, 4096 - 300 * (frame - this.entered)) / 4096 : 1;
  }

  winnerAge(frame: number) { return frame - this.entered; }

  step(frame: number): 'winner' | 'burst' | 'land' | 'hitLand' | undefined {
    const p = this.player;
    if (this.enteredResult) {
      if (this.celebrating) {
        p.yaw = kkTurn(p.yaw, 0);
        if (this.winnerAge(frame) === CHEER_DELAY[p.ch]) animStart(p, WIN_CHEER);
      }
      animStep(p);
      return;
    }

    // Only idle, run and land dispatch the result flags. Jump and hit must finish first.
    if (this.outcome !== 'draw' && (p.st === IDLE || p.st === RUN || p.st === LAND || p.st === HIT_LAND || p.st === HIT_IDLE)) {
      this.entered = frame;
      p.y = 0;
      p.jc = 0;
      if (this.outcome === 'win') {
        p.st = WINNER;
        animStart(p, WIN_READY);
        return 'winner';
      }
      p.st = LOSER;
      animStart(p, IDLE_SCRIPT);
      return 'burst';
    }

    let landing: 'land' | 'hitLand' | undefined;
    const enter = (state: number) => {
      p.st = state;
      if (state === FALL || state === HIT_FALL) {
        kkStartFall(p);
        animStart(p, state === FALL ? FALL_SCRIPT : 7);
      } else {
        p.jc = 0;
        if (state === LAND || state === HIT_LAND) {
          p.y = 0;
          animStart(p, state === LAND ? LAND_SCRIPT : 8);
          landing = state === LAND ? 'land' : 'hitLand';
        } else animStart(p, state === HIT_IDLE ? 1 : IDLE_SCRIPT);
      }
    };
    if (p.st === RUN) enter(IDLE);
    else {
      if (p.st === FALL && p.y >= 0) enter(LAND);
      if (p.st === HIT_FALL && p.y >= 0) enter(HIT_LAND);
      animStep(p, enter);
      if (p.st === HIT && p.y >= 0 && !p.jr) { p.y = 0; p.jc = 0; }
    }
    if (kkStepJump(p, false)) enter(p.st === HIT ? HIT_FALL : FALL);
    p.yaw = kkTurn(p.yaw, p.hd);
    return landing;
  }
}
