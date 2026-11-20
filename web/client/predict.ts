import { DT, type Input, type InputState, type MiniGame, type World } from '../shared/types';
import { primePolarPad } from '../shared/games/pushOff';
import { cloneWorld, stepWorld } from '../shared/sim';

/**
 * Client-side prediction of the local player: keep the last authoritative world,
 * replay unacknowledged inputs on a copy with the same shared step function.
 */
export class Predictor {
  auth: World | null = null;
  pred: World | null = null;
  pending: Input[] = [];
  seq = 0;
  openingPolarPad?: InputState;

  constructor(private game: MiniGame, public slot: number | null) {}

  private step(i: Input) {
    if (!this.pred) return;
    if (this.pred.tick === 0 && this.slot != null && this.openingPolarPad) {
      primePolarPad(this.pred, this.slot, this.openingPolarPad);
    }
    const arr: (Input | null)[] = [null, null, null, null];
    if (this.slot != null) arr[this.slot] = i;
    stepWorld(this.pred, this.game, arr, DT);
  }

  onSnapshot(w: World, ack: number) {
    this.seq = Math.max(this.seq, ack);
    this.auth = w;
    this.pending = this.pending.filter((i) => i.seq > ack);
    this.pred = cloneWorld(w);
    for (const i of this.pending) this.step(i);
  }

  push(i: Input) {
    this.pending.push(i);
    if (this.pending.length > 30) this.pending.shift();
    this.step(i);
  }
}
