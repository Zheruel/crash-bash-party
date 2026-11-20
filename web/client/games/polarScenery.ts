import { Group } from 'three';
import type { ModelRef } from '../crash';

// USA L18 actors 0x1607 (0486.t29 at 0x489c). FUN_800c06d0 selects the
// shared Polar pack meshes and turns part13 through 180 degrees.
const TILT_SCENERY = [
  { part: 'part12', x: -207, y: 534, z: 6637, speed: 2, yaw: 0 },
  { part: 'part13', x: -4297, y: 533, z: 5071, speed: 3, yaw: Math.PI },
  { part: 'part14', x: -4601, y: 532, z: 8160, speed: 1, yaw: 0 },
  { part: 'part14', x: 4056, y: 532, z: 7724, speed: 1, yaw: 0 },
  { part: 'part12', x: -7560, y: 534, z: 6637, speed: 2, yaw: 0 },
];

const WRAP_AT = 6901;
const WRAP_TO = -7300;

export function addTiltScenery(stage: Group, scale: number, make: (ref: ModelRef) => Group | null) {
  const unit = scale / 1024;
  const scenery = new Group();
  scenery.name = 'tilt-scenery';
  const objects = TILT_SCENERY.flatMap(({ part, x, y, z, speed, yaw }) => {
    const object = make({ model: 403, scale, parts: [part] });
    if (!object) return [];
    object.position.set(x * unit, -y * unit, -z * unit);
    object.rotation.y = yaw;
    scenery.add(object);
    return [{ object, x, speed, firstWrap: Math.ceil((WRAP_AT - x) / speed), cycle: Math.ceil((WRAP_AT - WRAP_TO) / speed) }];
  });
  stage.add(scenery);
  // FUN_800ca850 advances x during the intro, play and results.
  let lastTick = -1;
  return (tick: number) => {
    if (tick === lastTick) return;
    for (const { object, x, speed, firstWrap, cycle } of objects) {
      const rawX = tick < firstWrap ? x + speed * tick : WRAP_TO + speed * ((tick - firstWrap) % cycle);
      object.position.x = rawX * unit;
    }
    lastTick = tick;
  };
}
