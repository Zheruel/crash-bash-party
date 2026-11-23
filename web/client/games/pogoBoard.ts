// USA overlay 0725, FUN_800b7c3c (tile texture/CLUT), FUN_800bbc94 (joined edges)
// FUN_800b3c44 fills the 8x8 grid from the placed tile objects; FUN_800b8098 / FUN_800b7ee4 write their render words.
// and FUN_800bcb4c (rim render word). Atlas cells come from tools/build_pogo_board.py.
import * as THREE from 'three';
import { pogoJoinedEdges, tileCenter, TP_TILE } from '../../shared/games/tilePainter';
import type { World } from '../../shared/types';
import { ps1Material } from '../crash';
import { catalogInstance } from './kit';
import type { Placement } from './ps1cam';

const U = TP_TILE / 512;
export const POGO_RIM_PARTS = ['extra_1d044', ...Array.from({ length: 31 }, (_, i) => 'part' + (11 + i))];
const CORNERS = [[0, 0], [1, 0], [0, 1], [0, 1], [1, 0], [1, 1]];

export function pogoBoardCell(level: number, d: World['data'], i: number, tick: number) {
  const state = d.st[i], previous = d.prev[i];
  const held = state === 3 && d.tm[i] === 10 ? d.cashPaint?.[i] : undefined;
  let owner = d.tiles[i];
  if ((state === 0 && (tick & 1)) || state === 2) owner = previous;
  if (state === 3) {
    const showPrevious = d.tm[i] === 10 || (tick & 1) !== 0;
    owner = held?.owner ?? (showPrevious ? previous : -1);
  }
  switch (level) {
    case 10: return owner < 0 ? 65 : 66 + owner;
    case 11: return owner < 0 ? 64 : owner * 16 + (held?.edges ?? pogoJoinedEdges(i, d.tiles, d.border));
    case 12:
      if (state === 5) return 75 + Math.min(3, Math.floor(d.tm[i] / 30));
      if (state === 7) return 79;
      return owner < 0 ? 70 : 71 + owner;
    default: return owner < 0 ? 80 : (state === 10 || held?.locked ? 85 : 81) + owner;
  }
}

export class PogoBoard {
  readonly root = new THREE.Group();
  private geometry = new THREE.BufferGeometry();
  private material: THREE.Material;
  private uv = new THREE.BufferAttribute(new Float32Array(64 * 6 * 2), 2).setUsage(THREE.DynamicDrawUsage);
  private cells = new Int16Array(64).fill(-1);
  private rim: THREE.Object3D[] = [];
  private phase = 0;

  constructor(private level: number, model: number | undefined, placements: Placement[], texture: THREE.Texture) {
    texture.flipY = false;
    const source = new THREE.MeshBasicMaterial({ map: texture });
    source.userData.textured = true;
    this.material = ps1Material(source);
    source.dispose();
    // The game replaces the packet UVs while retaining each placed quad's corners and vertex colours.
    const floor = model !== undefined && placements.length ? catalogInstance({ model, parts: placements.map(o => o.part) }) : null;
    const positions = new Float32Array(64 * 18), colors = new Float32Array(64 * 18);
    for (let i = 0; i < 64; i++) {
      const x = i % 8, row = i >> 3, placed = placements[x * 8 + row];
      const tile = placed ? floor?.root.getObjectByName(placed.part) as THREE.Mesh | undefined : undefined;
      const pos = tile?.geometry?.getAttribute('position'), color = tile?.geometry?.getAttribute('color');
      const [cx, cz] = tileCenter(i);
      for (let v = 0; v < 6; v++) {
        const offset = (i * 6 + v) * 3, [u, t] = CORNERS[v];
        if (pos && placed) positions.set([(placed.pos[0] + pos.getX(v)) * U, -(placed.pos[1] + pos.getY(v)) * U, -(placed.pos[2] + pos.getZ(v)) * U], offset);
        else positions.set([cx + (u - 0.5) * TP_TILE, -4 * U, cz + (t - 0.5) * TP_TILE], offset);
        colors.set(color ? [color.getX(v), color.getY(v), color.getZ(v)] : [0.5, 0.5, 0.5], offset);
      }
    }
    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.geometry.setAttribute('uv', this.uv);
    const mesh = new THREE.Mesh(this.geometry, this.material);
    mesh.name = 'pogoFloor';
    this.root.add(mesh);

    if (level === 11 && model !== undefined) {
      const instance = catalogInstance({ model, scale: U * 1024, parts: POGO_RIM_PARTS });
      if (instance) {
        const stages = POGO_RIM_PARTS.map(part => instance.root.getObjectByName(part));
        stages.forEach((part, i) => { if (part) part.visible = i === 0; });
        if (stages.every(part => part !== undefined)) this.rim = stages;
        this.root.add(instance.root);
      }
    }
  }

  update(d: World['data'], tick: number) {
    let dirty = false;
    for (let i = 0; i < 64; i++) {
      const cell = pogoBoardCell(this.level, d, i, tick);
      if (cell === this.cells[i]) continue;
      const x = cell % 16 * 64, y = (cell >> 4) * 64;
      const edge = cell >= 75 && cell <= 78 ? 31 : 63;
      for (let v = 0; v < 6; v++) {
        const [u, t] = CORNERS[v];
        this.uv.setXY(i * 6 + v, (x + 0.5 + u * edge) / 1024, (y + 0.5 + t * edge) / 384);
      }
      this.cells[i] = cell;
      dirty = true;
    }
    if (dirty) this.uv.needsUpdate = true;
    if (this.rim.length && this.phase !== d.border) {
      this.rim[this.phase].visible = false;
      this.rim[d.border].visible = true;
      this.phase = d.border;
    }
  }

  dispose() {
    this.root.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}
