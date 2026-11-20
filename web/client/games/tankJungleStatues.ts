import type { Group } from 'three';
import { TA_K, taWorld } from '../../shared/games/tankArena';
import { stepJungleStatues, type JungleStatues, type StatueEvents } from '../../shared/games/tankJungleStatues';
import type { ModelInstance } from '../crash';
import { catalogInstance } from './kit';

const silent: StatueEvents = { sound() {}, slam() {}, crushPickup() {} };

export class JungleStatueView {
  private models: ModelInstance[] = [];
  private replay?: { state: JungleStatues; tick: number; frame: number; settled: boolean };

  constructor(private root: Group, private resultEvents: StatueEvents) {}

  render(state: JungleStatues, tanks: { x: number; z: number; st: number }[], tick: number, frame: number, over: boolean, settled: boolean) {
    // Snapshots bracket the display clock. Fill the intervening native animation ticks
    // on a copy. Only the authority emits live damage and impact sounds.
    if (frame > 0) {
      if (!this.replay || this.replay.tick !== tick || this.replay.settled !== settled || this.replay.frame > frame) {
        this.replay = { state: structuredClone(state), tick, frame: 0, settled };
      }
      if (this.replay.frame < frame) {
        const present = tanks.filter(t => t.st !== 0x6a && t.st !== 0x6b);
        const events = settled && frame - this.replay.frame <= 4 ? this.resultEvents : silent;
        while (this.replay.frame < frame) {
          stepJungleStatues(this.replay.state, present, over, events);
          this.replay.frame++;
        }
      }
      state = this.replay.state;
    } else this.replay = undefined;
    for (const [index, actor] of state.actors.entries()) {
      let model = this.models[index];
      if (!model) {
        const instance = catalogInstance({ model: 776, parts: ['part0'], scale: TA_K });
        if (!instance) continue;
        model = this.models[index] = instance;
        model.root.name = 'jungle-statue-' + index;
        this.root.add(model.root);
      }
      const [x, z] = taWorld('jungle', actor.x, actor.z);
      model.root.position.set(x, -actor.y * TA_K / 1024, z);
      model.root.rotation.y = -actor.yaw * Math.PI / 2048;
      model.nativePose(actor.pose);
    }
  }
}
