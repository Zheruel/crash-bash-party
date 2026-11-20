import * as THREE from 'three';
import { TA_K, type TankPickup } from '../../shared/games/tankArena';
import { fxPartTemplate, pickupShadow } from './realFx';

const U = TA_K / 1024;
const RAD = Math.PI / 2048;
export class TankSupplyPickup extends THREE.Group {
  private crate = fxPartTemplate(786, 42, TA_K)?.clone();
  private crateShadow = pickupShadow(786, 41, TA_K);
  private itemShadow: THREE.Object3D;
  private items: THREE.Object3D[];

  constructor(private kind: number, private metal: boolean, fallback: () => THREE.Group) {
    super();
    this.name = 'tankSupply';
    this.itemShadow = kind === 2 ? pickupShadow(784, 14, TA_K) : pickupShadow(736, 0, TA_K);
    const parts = kind === 4 ? Array.from({ length: 14 }, (_, i) => 23 + i) : [kind === 2 ? 6 : kind === 3 ? 11 : 18];
    const pack = kind === 4 ? 736 : kind === 3 ? 786 : 784;
    this.items = parts.map(part => fxPartTemplate(pack, part, TA_K, kind === 4)?.clone() ?? fallback());
    if (this.crate) this.add(this.crate);
    this.add(this.crateShadow, this.itemShadow, ...this.items);
  }

  pose(k: TankPickup, tick: number, height: number, camera: THREE.Camera) {
    const descending = k.m === 5;
    const born = k.born ?? (tick - Math.max(0, Math.round((k.y + 1224) / 20)));
    const age = Math.max(0, tick - born);
    const landedAge = descending ? 0 : Math.max(0, tick - (k.landed ?? 0));
    const dropTicks = descending ? age : landedAge === 0 ? (this.metal ? 1 : 47) : 0;
    const sine = Math.round(Math.sin(((dropTicks * 120) & 4095) * RAD) * 4096);
    const showCrate = descending && !this.metal && !!this.crate;
    if (this.crate) {
      this.crate.visible = showCrate;
      this.crate.position.y = height;
      this.crate.rotation.z = -((sine * 25) >> 9) * RAD;
    }
    const frame = landedAge % this.items.length;
    for (let i = 0; i < this.items.length; i++) this.items[i].visible = !showCrate && i === frame;
    const item = this.items[frame];
    item.position.y = height;
    if (this.kind === 4) item.quaternion.copy(camera.quaternion);
    const yaw = this.kind === 2 ? -((landedAge * 40) & 4095) * RAD : 0;
    if (this.kind === 2) item.rotation.y = yaw;

    this.crateShadow.visible = descending;
    this.itemShadow.visible = !descending;
    const shadow = descending ? this.crateShadow : this.itemShadow;
    shadow.position.x = ((sine * -120) >> 12) * U;
    const scale = age === 0 ? 4096 + k.y : Math.trunc((4096 + k.y) * 2800 / 4096);
    const narrow = this.kind === 2 && age > 0;
    shadow.rotation.y = narrow ? yaw - Math.PI / 2 : 0;
    shadow.scale.set((narrow ? 1000 : scale) / 4096, 1, (narrow ? 2800 : scale) / 4096);
  }
}
