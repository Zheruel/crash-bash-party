import type { Group } from 'three';
import { U } from '../../shared/games/pushOff';
import { sfx } from '../shell/sound';
import { catalogInstance } from './kit';

export const BOMB_RIDER_HIDE_TICK = 17;
const BOMB_HIDE_TICK = 63;

/** FUN_800cab8c / FUN_800bfa98: one initial hold, then signed PS1 Y motion relative to the carrier's launch origin. */
function bombHeights(): number[] {
  let y = -0x898;
  let vy = 0x40;
  let contacts = 0;
  const heights = [y, y];
  while (heights.length < BOMB_HIDE_TICK) {
    y += vy;
    vy += 8;
    if (y > 0) {
      y = 0;
      if (++contacts < 5) vy = -vy >> 3;
    }
    heights.push(y);
  }
  return heights;
}

const HEIGHTS = bombHeights();

export class PolarBombExpiryView {
  private readonly props: (Group | undefined)[] = [];
  private readonly ages: number[] = [];

  constructor(private readonly root: Group) {}

  render(slot: number, age: number, origin?: { x: number; y: number; z: number }) {
    const previous = this.ages[slot] ?? -1;
    if (previous < 19 && (age === 19 || (age > 19 && age - previous <= 6))) {
      sfx.playFile('sfx/0447/9.mp3', 0.8); // 0x455 on first ground contact
    }
    this.ages[slot] = age < 0 ? -1 : Math.max(previous, age);
    const height = HEIGHTS[age];
    let prop = this.props[slot];
    if (height === undefined || !origin) {
      if (prop) prop.visible = false;
      return;
    }
    if (!prop) {
      // Render word 0x2003 uses shared pack 0403 part2 at 1x scale, with no tilt transform.
      prop = catalogInstance({ model: 403, scale: 1024 * U, parts: ['part2'] })?.root;
      if (!prop) return;
      prop.name = `polar-bomb-expiry-${slot}`;
      this.root.add(prop);
      this.props[slot] = prop;
    }
    prop.visible = true;
    prop.position.set(origin.x * U, -(origin.y + height) * U, -origin.z * U);
  }

  dispose() {
    for (const prop of this.props) prop?.removeFromParent();
  }
}
