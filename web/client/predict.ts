import { DT, type Input, type MiniGame, type World } from '../shared/types';
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

  constructor(private game: MiniGame, public slot: number | null) {}

  private inputsFor(i: Input) {
    const arr: (Input | null)[] = [null, null, null, null];
    if (this.slot != null) arr[this.slot] = i;
    return arr;
  }

  onSnapshot(w: World, ack: number) {
    this.auth = w;
    this.pending = this.pending.filter((i) => i.seq > ack);
    this.pred = cloneWorld(w);
    for (const i of this.pending) stepWorld(this.pred, this.game, this.inputsFor(i), DT);
  }

  push(i: Input) {
    this.pending.push(i);
    if (this.pending.length > 30) this.pending.shift();
    if (this.pred) stepWorld(this.pred, this.game, this.inputsFor(i), DT);
  }
}
