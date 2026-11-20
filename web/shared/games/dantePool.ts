// USA L26 uses a 0x7800-byte component pool. The four racers and the volcano
// retain its first 7572 bytes. Every temporary actor draws from the rest.
type Block = [offset: number, bytes: number];
interface DanteActor {
  body?: number;
  expires: number;
  blocks: Block[];
}
export interface DantePool {
  free: Block[];
  actors: (DanteActor | null)[];
  recycled: number[];
}

export function createDantePool(): DantePool {
  return { free: [[7572, 0x7800 - 7572 - 24]], actors: Array(5).fill(null), recycled: [] };
}

// FUN_800232b0 takes the first fitting entry. A split replaces the original
// entry in place, so the free list need not be sorted by size.
function reserve(pool: DantePool, bytes: number): Block | undefined {
  const index = pool.free.findIndex(block => block[1] >= bytes);
  if (index < 0) return;
  const [offset, size] = pool.free[index];
  if (size > bytes + 32) {
    pool.free[index] = [offset + bytes + 24, size - bytes - 24];
    return [offset, bytes];
  }
  return pool.free.splice(index, 1)[0];
}

// FUN_80023404 merges the higher neighbour first. Insertion starts at the
// last merged neighbour's position and puts the result before equal sizes.
function release(pool: DantePool, [offset, size]: Block) {
  let at = 0;
  const right = pool.free.findIndex(b => b[0] === offset + size + 24);
  if (right >= 0) {
    size += 24 + pool.free.splice(right, 1)[0][1];
    at = right;
  }
  const left = pool.free.findIndex(b => b[0] + b[1] + 24 === offset);
  if (left >= 0) {
    const b = pool.free.splice(left, 1)[0];
    offset = b[0];
    size += 24 + b[1];
    at = left;
  }
  while (at < pool.free.length && pool.free[at][1] < size) at++;
  pool.free.splice(at, 0, [offset, size]);
}

const dataBytes = { effect: 956, exhaust: 44, pickup: 80, missile: 120 } as const;

// Only the script-effect constructor destroys its transform if the data
// allocation fails. Pickups and missiles also request an optional reflection.
export function spawnDanteActor(pool: DantePool, kind: keyof typeof dataBytes, expires: number, body?: number): number {
  const id = pool.recycled.pop() ?? pool.actors.length;
  if (id >= 104) return 0;
  const transform = reserve(pool, 156);
  const data = transform && reserve(pool, dataBytes[kind]);
  if (!transform || (!data && kind === 'effect')) {
    if (transform) release(pool, transform);
    pool.actors[id] = null;
    pool.recycled.push(id);
    return 0;
  }

  const blocks = [transform];
  if (data) {
    blocks.push(data);
    if (kind === 'pickup' || kind === 'missile') {
      const reflection = reserve(pool, 156);
      if (reflection) blocks.push(reflection);
    }
  }
  const actor: DanteActor = { expires: data ? expires : -1, blocks };
  if (data && body !== undefined) actor.body = body;
  pool.actors[id] = actor;
  return id;
}

export function freeDanteActor(pool: DantePool, id: number) {
  const actor = pool.actors[id];
  if (!actor) return;
  pool.actors[id] = null;
  pool.recycled.push(id);
  for (const block of actor.blocks.reverse()) release(pool, block);
}
